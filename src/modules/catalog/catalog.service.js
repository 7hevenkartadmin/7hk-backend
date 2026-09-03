import slugify from 'slugify';
import { Product } from './product.model.js';
import { Category } from './category.model.js';
import { getPagination, paged } from '../../shared/utils/pagination.js';
import { AppError } from '../../shared/utils/AppError.js';
import { publishInventoryChange } from '../../shared/realtime/inventory.events.js';
import { env } from '../../config/env.js';
import { maxOrderableQuantity, netAvailableStock } from '../../shared/utils/inventory.js';
import { isSkuDuplicateKeyError, prepareNewProductSkus, prepareProductUpdateSkus } from './catalog.sku.js';
import {
  combineMongoFilters,
  paanCornerCategoryExclusion,
  paanCornerProductExclusion,
} from './paanCorner.visibility.js';

const SKU_WRITE_ATTEMPTS = 5;

const sortMap = {
  popularity: { popularity: -1, createdAt: -1, _id: 1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: 1 },
  discount: { discount: -1, _id: 1 },
  newest: { createdAt: -1, _id: 1 },
  name_asc: { name: 1, _id: 1 },
  stock_asc: { availableStock: 1, name: 1, _id: 1 },
};

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultVariantIndex(variants = []) {
  const preferred = variants.findIndex((variant) => variant.isDefault && variant.isActive !== false);
  if (preferred >= 0) return preferred;
  const active = variants.findIndex((variant) => variant.isActive !== false);
  return active >= 0 ? active : 0;
}

export function inventorySummary(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const active = variants.filter((variant) => variant.isActive !== false);
  if (variants.length === 0) {
    const onHand = Number(product?.stock || 0);
    const reserved = Number(product?.reservedStock || 0);
    return { totalStock: onHand, reservedStock: reserved, availableStock: netAvailableStock(onHand, reserved) };
  }
  if (active.length === 0) return { totalStock: 0, reservedStock: 0, availableStock: 0 };
  return active.reduce((summary, variant) => {
    const onHand = Number(variant.stock || 0);
    const reserved = Number(variant.reservedStock || 0);
    summary.totalStock += onHand;
    summary.reservedStock += reserved;
    summary.availableStock += netAvailableStock(onHand, reserved);
    return summary;
  }, { totalStock: 0, reservedStock: 0, availableStock: 0 });
}

export function variantStockStatusExpression(status, threshold = env.LOW_STOCK_THRESHOLD) {
  const available = {
    $max: [0, {
      $subtract: [
        { $ifNull: ['$$variant.stock', 0] },
        { $ifNull: ['$$variant.reservedStock', 0] },
      ],
    }],
  };
  const statusMatch = status === 'out'
    ? { $eq: [available, 0] }
    : { $and: [{ $gt: [available, 0] }, { $lt: [available, threshold] }] };
  return {
    $anyElementTrue: {
      $map: {
        input: { $ifNull: ['$variants', []] },
        as: 'variant',
        in: { $and: [{ $eq: ['$$variant.isActive', true] }, statusMatch] },
      },
    },
  };
}

async function resolveCategoryHierarchy(payload, existingProduct = null) {
  const hasCategoryRef = Object.hasOwn(payload, 'categoryRef');
  const hasSubcategoryRef = Object.hasOwn(payload, 'subcategoryRef');
  if (!hasCategoryRef && !hasSubcategoryRef) return payload;

  const categoryRef = hasCategoryRef ? payload.categoryRef : existingProduct?.categoryRef;
  const subcategoryRef = hasSubcategoryRef ? payload.subcategoryRef : existingProduct?.subcategoryRef;
  const ids = [categoryRef, subcategoryRef].filter(Boolean);
  const categories = ids.length ? await Category.find({ _id: { $in: ids } }) : [];
  const category = categoryRef
    ? categories.find((item) => String(item._id) === String(categoryRef))
    : null;
  const subcategory = subcategoryRef
    ? categories.find((item) => String(item._id) === String(subcategoryRef))
    : null;

  if (categoryRef && (!category || category.parent)) {
    throw new AppError('Please select a valid top-level category', 400, 'INVALID_CATEGORY_HIERARCHY');
  }
  if (subcategoryRef && (!subcategory || !subcategory.parent)) {
    throw new AppError('Please select a valid subcategory', 400, 'INVALID_CATEGORY_HIERARCHY');
  }
  if (subcategory && (!category || String(subcategory.parent) !== String(category._id))) {
    throw new AppError('The selected subcategory does not belong to this category', 400, 'INVALID_CATEGORY_HIERARCHY');
  }

  const update = { ...payload };
  if (hasCategoryRef) update.categoryRef = category?._id || undefined;
  if (hasSubcategoryRef) update.subcategoryRef = subcategory?._id || undefined;
  if (category) update.category = category.slug;
  return update;
}

async function validateCategoryParent(categoryId, parentId) {
  if (!parentId) return null;
  if (categoryId && String(categoryId) === String(parentId)) {
    throw new AppError('A category cannot be its own parent', 400, 'INVALID_CATEGORY_HIERARCHY');
  }
  const parent = await Category.findById(parentId);
  if (!parent) throw new AppError('Parent category not found', 404, 'CATEGORY_NOT_FOUND');
  if (parent.parent) {
    throw new AppError('Only two category levels are supported', 400, 'INVALID_CATEGORY_HIERARCHY');
  }
  if (categoryId && await Category.exists({ parent: categoryId })) {
    throw new AppError('A category with subcategories cannot become a subcategory', 409, 'CATEGORY_HAS_CHILDREN');
  }
  return parent;
}

export function toPublicProduct(product) {
  const item = typeof product?.toObject === 'function' ? product.toObject() : { ...product };
  const summary = inventorySummary(item);
  const defaultVariant = item.variants?.find((variant) => variant.isDefault && variant.isActive !== false)
    || item.variants?.find((variant) => variant.isActive !== false);
  const defaultMaximum = defaultVariant
    ? maxOrderableQuantity(defaultVariant.stock, defaultVariant.reservedStock, { isActive: defaultVariant.isActive !== false })
    : item.variants?.length
      ? 0
      : maxOrderableQuantity(item.stock, item.reservedStock, { isActive: item.isActive !== false });
  item.isAvailable = item.isActive !== false && summary.availableStock > 0;
  item.maxOrderableQuantity = defaultMaximum;
  item.defaultVariantId = defaultVariant?._id;
  item.defaultVariantAvailable = defaultMaximum > 0;
  item.defaultVariantMaxOrderableQuantity = defaultMaximum;
  delete item.stock;
  delete item.reservedStock;
  delete item.totalStock;
  delete item.availableStock;
  item.variants = Array.isArray(item.variants) ? item.variants.map((variant) => {
    const safeMaximum = maxOrderableQuantity(variant.stock, variant.reservedStock, {
      isActive: item.isActive !== false && variant.isActive !== false,
    });
    const publicVariant = { ...variant, isAvailable: safeMaximum > 0, maxOrderableQuantity: safeMaximum };
    delete publicVariant.stock;
    delete publicVariant.reservedStock;
    return publicVariant;
  }) : [];
  return item;
}

function searchFilter(searchText) {
  const terms = String(searchText || '')
    .trim()
    .slice(0, 120)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  if (terms.length === 0) return null;

  const fields = [
    'name',
    'description',
    'brand',
    'category',
    'sku',
    'barcode.value',
    'variants.title',
    'variants.unit',
    'variants.sku',
    'variants.barcode.value',
    'tags',
  ];
  return {
    $and: terms.map((term) => {
      const pattern = new RegExp(escapeRegex(term), 'i');
      return { $or: fields.map((field) => ({ [field]: pattern })) };
    }),
  };
}

function searchRankFields(searchText) {
  const clean = String(searchText || '').trim().slice(0, 120);
  if (!clean) return null;
  const escaped = escapeRegex(clean);
  const startsWith = new RegExp(`^${escaped}`, 'i');
  const contains = new RegExp(escaped, 'i');
  const firstTerm = clean.split(/\s+/).find(Boolean);
  const firstTermRegex = firstTerm ? new RegExp(escapeRegex(firstTerm), 'i') : contains;

  return {
    searchRank: {
      $add: [
        { $cond: [{ $regexMatch: { input: '$name', regex: startsWith } }, 70, 0] },
        { $cond: [{ $regexMatch: { input: '$name', regex: contains } }, 45, 0] },
        { $cond: [{ $regexMatch: { input: '$brand', regex: firstTermRegex } }, 18, 0] },
        { $cond: [{ $regexMatch: { input: '$category', regex: firstTermRegex } }, 14, 0] },
        { $cond: [{ $regexMatch: { input: '$sku', regex: firstTermRegex } }, 10, 0] },
        { $cond: [{ $regexMatch: { input: '$description', regex: firstTermRegex } }, 4, 0] },
      ],
    },
  };
}

export async function listProducts(query, options = {}) {
  const { page, limit, skip } = getPagination(query);
  const filter = options.includeInactive ? {} : { isActive: true };
  const search = searchFilter(query.q);
  if (search) Object.assign(filter, search);
  if (query.category && query.category !== 'all') {
    const category = await Category.findOne({ $or: [{ slug: query.category }, ...(query.category.match(/^[a-f\d]{24}$/i) ? [{ _id: query.category }] : [])] });
    if (category) filter[category.parent ? 'subcategoryRef' : 'categoryRef'] = category._id;
    else filter.category = query.category;
  }
  if (query.subcategory) {
    const subcategory = await Category.findOne({ $or: [{ slug: query.subcategory }, ...(query.subcategory.match(/^[a-f\d]{24}$/i) ? [{ _id: query.subcategory }] : [])] });
    if (subcategory) filter.subcategoryRef = subcategory._id;
  }
  if (query.featured !== undefined) filter.isFeatured = query.featured;
  if (query.active === 'active') filter.isActive = true;
  if (query.active === 'inactive') filter.isActive = false;
  if (query.stockStatus === 'out') filter.$expr = variantStockStatusExpression('out');
  if (query.stockStatus === 'low') filter.$expr = variantStockStatusExpression('low');
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    filter.price = {};
    if (query.minPrice !== undefined) filter.price.$gte = query.minPrice;
    if (query.maxPrice !== undefined) filter.price.$lte = query.maxPrice;
  }
  const visibilityFilter = options.excludePaanCorner ? await paanCornerProductExclusion() : null;
  const effectiveFilter = combineMongoFilters(filter, visibilityFilter);
  let itemsQuery = Product.find(effectiveFilter).populate('categoryRef', 'name slug').populate('subcategoryRef', 'name slug parent').sort(sortMap[query.sort] || sortMap.popularity).skip(skip).limit(limit);
  if (search) {
    const rankFields = searchRankFields(query.q);
    const searchSort = query.sort && query.sort !== 'popularity'
      ? { ...sortMap[query.sort], _id: 1 }
      : { searchRank: -1, popularity: -1, createdAt: -1, _id: 1 };
    itemsQuery = Product.aggregate([
      { $match: effectiveFilter },
      { $addFields: rankFields },
      { $sort: searchSort },
      { $skip: skip },
      { $limit: limit },
    ]);
  }
  const [rawItems, total] = await Promise.all([
    itemsQuery,
    Product.countDocuments(effectiveFilter),
  ]);
  const items = search
    ? await Product.populate(rawItems, [
      { path: 'categoryRef', select: 'name slug' },
      { path: 'subcategoryRef', select: 'name slug parent' },
    ])
    : rawItems;
  const responseItems = options.exposeInventory
    ? items.map((product) => {
      const item = typeof product?.toObject === 'function' ? product.toObject() : { ...product };
      return { ...item, ...inventorySummary(item) };
    })
    : items.map(toPublicProduct);
  return paged(responseItems, total, page, limit);
}

export async function listHomepageShelves(limit = 15, options = {}) {
  const shelfLimit = Math.min(Math.max(Number(limit || 15), 1), 15);
  const categoryVisibility = options.excludePaanCorner ? await paanCornerCategoryExclusion() : null;
  const productVisibility = options.excludePaanCorner ? await paanCornerProductExclusion() : null;
  const categories = await Category.find(combineMongoFilters({ isActive: true, parent: null }, categoryVisibility)).sort({ sortOrder: 1, name: 1 });
  const shelves = await Promise.all(categories.map(async (category) => {
    const products = await Product.find(combineMongoFilters({ isActive: true, categoryRef: category._id }, productVisibility))
      .populate('categoryRef', 'name slug')
      .populate('subcategoryRef', 'name slug parent')
      .sort(sortMap.popularity)
      .limit(shelfLimit);
    return {
      categoryId: String(category._id),
      categorySlug: category.slug,
      products: products.map(toPublicProduct),
    };
  }));
  return { shelves: shelves.filter((shelf) => shelf.products.length > 0), limit: shelfLimit };
}

export async function getProductRecommendations(idOrSlug, limit = 10, options = {}) {
  const product = await getProductById(idOrSlug, options);
  const productId = product._id || product.id;
  const categoryId = product.categoryRef?._id || product.categoryRef;
  const recommendationLimit = Math.min(Math.max(Number(limit || 10), 1), 15);
  const visibilityFilter = options.excludePaanCorner ? await paanCornerProductExclusion() : null;
  const [similar, popular] = await Promise.all([
    Product.find(combineMongoFilters({
      _id: { $ne: productId },
      isActive: true,
      ...(categoryId ? { categoryRef: categoryId } : { category: product.category }),
    }, visibilityFilter)).populate('categoryRef', 'name slug').populate('subcategoryRef', 'name slug parent')
      .sort(sortMap.popularity).limit(recommendationLimit),
    Product.find(combineMongoFilters({
      _id: { $ne: productId },
      isActive: true,
      ...(categoryId ? { categoryRef: { $ne: categoryId } } : { category: { $ne: product.category } }),
    }, visibilityFilter)).populate('categoryRef', 'name slug').populate('subcategoryRef', 'name slug parent')
      .sort(sortMap.popularity).limit(recommendationLimit),
  ]);
  return {
    similar: similar.map(toPublicProduct),
    popular: popular.map(toPublicProduct),
  };
}

export async function searchSuggestions(query, options = {}) {
  const clean = String(query.q || '').trim();
  const limit = Number(query.limit || 6);
  const result = await listProducts({ q: clean, category: query.category, limit: 30, page: 1 }, options);
  const normalizedQuery = clean.toLocaleLowerCase();
  const suggestions = [];
  const seen = new Set();

  const matchingVariant = (product, keyword) => {
    const needle = String(keyword || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    if (!needle) return null;
    return (product?.variants || []).find((variant) => {
      if (variant.isActive === false) return false;
      const title = String(variant.title || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
      return Boolean(title) && (title.includes(needle) || needle.includes(title));
    }) || null;
  };

  const add = (keyword, product, kind = 'keyword', sourceVariant = null) => {
    const value = String(keyword || '').replace(/\s+/g, ' ').trim();
    const key = value.toLocaleLowerCase();
    if (value.length < 2 || seen.has(key) || !key.includes(normalizedQuery)) return;
    const variant = sourceVariant || matchingVariant(product, value);
    seen.add(key);
    suggestions.push({
      keyword: value,
      image: variant?.images?.[0] || product?.image || product?.gallery?.[0] || '',
      kind,
    });
  };

  for (const product of result.items) {
    add(product.name, product, 'product');
    add(product.brand, product, 'brand');
    for (const variant of product.variants || []) {
      if (variant.isActive !== false) add(variant.title, product, 'variant', variant);
    }
    for (const tag of product.tags || []) add(tag, product, 'tag');
  }

  suggestions.sort((a, b) => {
    const aStarts = a.keyword.toLocaleLowerCase().startsWith(normalizedQuery) ? 1 : 0;
    const bStarts = b.keyword.toLocaleLowerCase().startsWith(normalizedQuery) ? 1 : 0;
    return bStarts - aStarts || a.keyword.length - b.keyword.length;
  });

  return { suggestions: suggestions.slice(0, limit) };
}

export async function getProductById(idOrSlug, options = {}) {
  const lookup = idOrSlug.match(/^[a-f\d]{24}$/i) ? { _id: idOrSlug } : { slug: idOrSlug };
  const visibilityFilter = options.excludePaanCorner ? await paanCornerProductExclusion() : null;
  const product = await Product.findOne(combineMongoFilters(lookup, visibilityFilter)).populate('categoryRef', 'name slug').populate('subcategoryRef', 'name slug parent');
  if (!product || !product.isActive) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  return toPublicProduct(product);
}

export async function createProduct(payload) {
  const slug = slugify(payload.name, { lower: true, strict: true });
  const normalized = await resolveCategoryHierarchy(payload);
  for (let attempt = 0; attempt < SKU_WRITE_ATTEMPTS; attempt += 1) {
    const productPayload = prepareNewProductSkus(normalized);
    try {
      const product = await Product.create({ ...productPayload, slug });
      publishInventoryChange({ action: 'product.created', productId: String(product._id), stock: product.stock, isActive: product.isActive });
      return product.populate('categoryRef subcategoryRef', 'name slug parent');
    } catch (error) {
      if (!isSkuDuplicateKeyError(error)) throw error;
    }
  }
  throw new AppError('Could not allocate a unique SKU. Please try again.', 503, 'SKU_GENERATION_FAILED');
}

export async function updateProduct(id, payload) {
  for (let attempt = 0; attempt < SKU_WRITE_ATTEMPTS; attempt += 1) {
    const product = await Product.findById(id);
    if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
    const resolved = await resolveCategoryHierarchy(payload, product);
    const update = prepareProductUpdateSkus(resolved, product.variants);
    if (update.name) update.slug = slugify(update.name, { lower: true, strict: true });

    const variantsWereReplaced = Object.hasOwn(update, 'variants');
    if (variantsWereReplaced && product.variants?.length) {
      const incomingIds = new Set(update.variants.map((variant) => String(variant._id || '')).filter(Boolean));
      const retiredVariants = product.variants
        .filter((variant) => !incomingIds.has(String(variant._id)))
        .map((variant) => ({ ...variant.toObject(), isDefault: false, isActive: false }));
      update.variants = [...update.variants, ...retiredVariants];
    }
    if (!variantsWereReplaced && product.variants?.length) {
      const selected = product.variants[defaultVariantIndex(product.variants)];
      const mirroredFields = ['unit', 'mrp', 'price', 'stock', 'reservedStock', 'barcode'];
      for (const field of mirroredFields) {
        selected[field] = Object.hasOwn(update, field) ? update[field] : product[field];
      }
    }

    product.set(update);
    try {
      await product.save();
      publishInventoryChange({ action: 'product.updated', productId: String(product._id), stock: product.stock, isActive: product.isActive });
      return product.populate('categoryRef subcategoryRef', 'name slug parent');
    } catch (error) {
      if (!isSkuDuplicateKeyError(error)) throw error;
    }
  }
  throw new AppError('Could not allocate a unique SKU. Please try again.', 503, 'SKU_GENERATION_FAILED');
}

export async function deleteProduct(id) {
  const product = await Product.findByIdAndUpdate(id, { isActive: false }, { new: true });
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  publishInventoryChange({ action: 'product.archived', productId: String(product._id), stock: product.stock, isActive: product.isActive });
  return product.populate('categoryRef subcategoryRef', 'name slug parent');
}

export async function listCategories(options = {}) {
  const activeFilter = options.includeInactive ? {} : { isActive: true };
  const visibilityFilter = options.excludePaanCorner ? await paanCornerCategoryExclusion() : null;
  const filter = combineMongoFilters(activeFilter, visibilityFilter);
  return Category.find(filter).populate('parent', 'name slug').sort({ parent: 1, sortOrder: 1, name: 1 });
}

export async function createCategory(payload) {
  const parent = await validateCategoryParent(null, payload.parent);
  if (payload.isActive !== false && parent?.isActive === false) {
    throw new AppError('Activate the parent category before adding an active subcategory', 409, 'INACTIVE_PARENT_CATEGORY');
  }
  const category = await Category.create(payload);
  return category.populate('parent', 'name slug');
}

export async function updateCategory(id, payload) {
  const existing = await Category.findById(id);
  if (!existing) throw new AppError('Category not found', 404, 'CATEGORY_NOT_FOUND');
  if (Object.hasOwn(payload, 'parent')) await validateCategoryParent(id, payload.parent);
  if (payload.isActive === true) {
    const parentId = Object.hasOwn(payload, 'parent') ? payload.parent : existing.parent;
    const parent = parentId ? await Category.findById(parentId) : null;
    if (parent && parent.isActive === false) {
      throw new AppError('Activate the parent category first', 409, 'INACTIVE_PARENT_CATEGORY');
    }
  }

  const category = await Category.findByIdAndUpdate(id, payload, { new: true, runValidators: true });
  if (!category) throw new AppError('Category not found', 404, 'CATEGORY_NOT_FOUND');
  if (payload.isActive === false) {
    const childIds = await Category.find({ parent: id }).distinct('_id');
    await Promise.all([
      Category.updateMany({ parent: id }, { isActive: false }),
      Product.updateMany(
        { $or: [{ categoryRef: id }, { subcategoryRef: id }, { subcategoryRef: { $in: childIds } }] },
        { isActive: false },
      ),
    ]);
  }
  return category.populate('parent', 'name slug');
}
