import slugify from 'slugify';
import { Product } from './product.model.js';
import { Category } from './category.model.js';
import { getPagination, paged } from '../../shared/utils/pagination.js';
import { AppError } from '../../shared/utils/AppError.js';
import { publishInventoryChange } from '../../shared/realtime/inventory.events.js';
import { env } from '../../config/env.js';

const sortMap = {
  popularity: { popularity: -1, createdAt: -1 },
  price_asc: { price: 1 },
  price_desc: { price: -1 },
  discount: { discount: -1 },
  newest: { createdAt: -1 },
  name_asc: { name: 1 },
  stock_asc: { stock: 1, name: 1 },
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
  item.isAvailable = Number(item.stock || 0) > 0;
  delete item.stock;
  delete item.reservedStock;
  item.variants = Array.isArray(item.variants) ? item.variants.map((variant) => {
    const publicVariant = { ...variant, isAvailable: Number(variant.stock || 0) > 0 };
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

  const fields = ['name', 'description', 'brand', 'category', 'sku', 'barcode.value', 'variants.sku', 'variants.barcode.value', 'tags'];
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
  if (query.stockStatus === 'out') filter.stock = 0;
  if (query.stockStatus === 'low') filter.stock = { $gt: 0, $lt: env.LOW_STOCK_THRESHOLD };
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    filter.price = {};
    if (query.minPrice !== undefined) filter.price.$gte = query.minPrice;
    if (query.maxPrice !== undefined) filter.price.$lte = query.maxPrice;
  }
  let itemsQuery = Product.find(filter).populate('categoryRef', 'name slug').populate('subcategoryRef', 'name slug parent').sort(sortMap[query.sort] || sortMap.popularity).skip(skip).limit(limit);
  if (search) {
    const rankFields = searchRankFields(query.q);
    const searchSort = query.sort && query.sort !== 'popularity'
      ? { ...sortMap[query.sort], _id: 1 }
      : { searchRank: -1, popularity: -1, createdAt: -1, _id: 1 };
    itemsQuery = Product.aggregate([
      { $match: filter },
      { $addFields: rankFields },
      { $sort: searchSort },
      { $skip: skip },
      { $limit: limit },
    ]);
  }
  const [rawItems, total] = await Promise.all([
    itemsQuery,
    Product.countDocuments(filter),
  ]);
  const items = search
    ? await Product.populate(rawItems, [
      { path: 'categoryRef', select: 'name slug' },
      { path: 'subcategoryRef', select: 'name slug parent' },
    ])
    : rawItems;
  return paged(options.exposeInventory ? items : items.map(toPublicProduct), total, page, limit);
}

export async function listHomepageShelves(limit = 15) {
  const shelfLimit = Math.min(Math.max(Number(limit || 15), 1), 15);
  const categories = await Category.find({ isActive: true, parent: null }).sort({ sortOrder: 1, name: 1 });
  const shelves = await Promise.all(categories.map(async (category) => {
    const products = await Product.find({ isActive: true, categoryRef: category._id })
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

export async function getProductRecommendations(idOrSlug, limit = 10) {
  const product = await getProductById(idOrSlug);
  const productId = product._id || product.id;
  const categoryId = product.categoryRef?._id || product.categoryRef;
  const recommendationLimit = Math.min(Math.max(Number(limit || 10), 1), 15);
  const [similar, popular] = await Promise.all([
    Product.find({
      _id: { $ne: productId },
      isActive: true,
      ...(categoryId ? { categoryRef: categoryId } : { category: product.category }),
    }).populate('categoryRef', 'name slug').populate('subcategoryRef', 'name slug parent')
      .sort(sortMap.popularity).limit(recommendationLimit),
    Product.find({
      _id: { $ne: productId },
      isActive: true,
      ...(categoryId ? { categoryRef: { $ne: categoryId } } : { category: { $ne: product.category } }),
    }).populate('categoryRef', 'name slug').populate('subcategoryRef', 'name slug parent')
      .sort(sortMap.popularity).limit(recommendationLimit),
  ]);
  return {
    similar: similar.map(toPublicProduct),
    popular: popular.map(toPublicProduct),
  };
}

export async function searchSuggestions(query) {
  const clean = String(query.q || '').trim();
  const limit = Number(query.limit || 6);
  const result = await listProducts({ q: clean, category: query.category, limit: 30, page: 1 });
  const normalizedQuery = clean.toLocaleLowerCase();
  const suggestions = [];
  const seen = new Set();

  const add = (keyword, product, kind = 'keyword') => {
    const value = String(keyword || '').replace(/\s+/g, ' ').trim();
    const key = value.toLocaleLowerCase();
    if (value.length < 2 || seen.has(key) || !key.includes(normalizedQuery)) return;
    seen.add(key);
    suggestions.push({
      keyword: value,
      image: product?.image || product?.gallery?.[0] || '',
      kind,
    });
  };

  for (const product of result.items) {
    add(product.name, product, 'product');
    add(product.brand, product, 'brand');
    for (const tag of product.tags || []) add(tag, product, 'tag');
  }

  suggestions.sort((a, b) => {
    const aStarts = a.keyword.toLocaleLowerCase().startsWith(normalizedQuery) ? 1 : 0;
    const bStarts = b.keyword.toLocaleLowerCase().startsWith(normalizedQuery) ? 1 : 0;
    return bStarts - aStarts || a.keyword.length - b.keyword.length;
  });

  return { suggestions: suggestions.slice(0, limit) };
}

export async function getProductById(idOrSlug) {
  const lookup = idOrSlug.match(/^[a-f\d]{24}$/i) ? { _id: idOrSlug } : { slug: idOrSlug };
  const product = await Product.findOne(lookup).populate('categoryRef', 'name slug').populate('subcategoryRef', 'name slug parent');
  if (!product || !product.isActive) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  return toPublicProduct(product);
}

export async function createProduct(payload) {
  const slug = slugify(payload.name, { lower: true, strict: true });
  const normalized = await resolveCategoryHierarchy(payload);
  const product = await Product.create({ ...normalized, slug });
  publishInventoryChange({ action: 'product.created', productId: String(product._id), stock: product.stock, isActive: product.isActive });
  return product.populate('categoryRef subcategoryRef', 'name slug parent');
}

export async function updateProduct(id, payload) {
  const product = await Product.findById(id);
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  const update = await resolveCategoryHierarchy(payload, product);
  if (update.name) update.slug = slugify(update.name, { lower: true, strict: true });

  const variantsWereReplaced = Object.hasOwn(update, 'variants');
  if (!variantsWereReplaced && product.variants?.length) {
    const selected = product.variants[defaultVariantIndex(product.variants)];
    const mirroredFields = ['sku', 'unit', 'mrp', 'price', 'stock', 'reservedStock', 'barcode'];
    for (const field of mirroredFields) {
      selected[field] = Object.hasOwn(update, field) ? update[field] : product[field];
    }
  }

  product.set(update);
  await product.save();
  publishInventoryChange({ action: 'product.updated', productId: String(product._id), stock: product.stock, isActive: product.isActive });
  return product.populate('categoryRef subcategoryRef', 'name slug parent');
}

export async function deleteProduct(id) {
  const product = await Product.findByIdAndUpdate(id, { isActive: false }, { new: true });
  if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');
  publishInventoryChange({ action: 'product.archived', productId: String(product._id), stock: product.stock, isActive: product.isActive });
  return product.populate('categoryRef subcategoryRef', 'name slug parent');
}

export async function listCategories(options = {}) {
  const filter = options.includeInactive ? {} : { isActive: true };
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
