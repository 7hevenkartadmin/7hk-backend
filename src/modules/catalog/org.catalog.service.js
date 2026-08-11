import slugify from "slugify";
import { Product } from "./product.model.js";
import { Category } from "./category.model.js";
import { getPagination, paged } from "../../shared/utils/pagination.js";
import { AppError } from "../../shared/utils/AppError.js";
import { publishInventoryChange } from "../../shared/realtime/inventory.events.js";

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
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function searchFilter(searchText) {
  const terms = String(searchText || "")
    .trim()
    .slice(0, 120)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  if (terms.length === 0) return null;

  const fields = [
    "name",
    "description",
    "brand",
    "category",
    "sku",
    "barcode.value",
  ];
  return {
    $and: terms.map((term) => {
      const pattern = new RegExp(escapeRegex(term), "i");
      return { $or: fields.map((field) => ({ [field]: pattern })) };
    }),
  };
}

function searchRankFields(searchText) {
  const clean = String(searchText || "")
    .trim()
    .slice(0, 120);
  if (!clean) return null;
  const escaped = escapeRegex(clean);
  const startsWith = new RegExp(`^${escaped}`, "i");
  const contains = new RegExp(escaped, "i");
  const firstTerm = clean.split(/\s+/).find(Boolean);
  const firstTermRegex = firstTerm
    ? new RegExp(escapeRegex(firstTerm), "i")
    : contains;

  return {
    searchRank: {
      $add: [
        {
          $cond: [
            { $regexMatch: { input: "$name", regex: startsWith } },
            70,
            0,
          ],
        },
        {
          $cond: [{ $regexMatch: { input: "$name", regex: contains } }, 45, 0],
        },
        {
          $cond: [
            { $regexMatch: { input: "$brand", regex: firstTermRegex } },
            18,
            0,
          ],
        },
        {
          $cond: [
            { $regexMatch: { input: "$category", regex: firstTermRegex } },
            14,
            0,
          ],
        },
        {
          $cond: [
            { $regexMatch: { input: "$sku", regex: firstTermRegex } },
            10,
            0,
          ],
        },
        {
          $cond: [
            { $regexMatch: { input: "$description", regex: firstTermRegex } },
            4,
            0,
          ],
        },
      ],
    },
  };
}

export async function listProducts(query, options = {}) {
  const { page, limit, skip } = getPagination(query);
  const filter = options.includeInactive ? {} : { isActive: true };
  const search = searchFilter(query.q);
  if (search) Object.assign(filter, search);
  if (query.category && query.category !== "all")
    filter.category = query.category;
  if (query.featured !== undefined) filter.isFeatured = query.featured;
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    filter.price = {};
    if (query.minPrice !== undefined) filter.price.$gte = query.minPrice;
    if (query.maxPrice !== undefined) filter.price.$lte = query.maxPrice;
  }
  let itemsQuery = Product.find(filter)
    .sort(sortMap[query.sort] || sortMap.popularity)
    .skip(skip)
    .limit(limit);
  if (search) {
    const rankFields = searchRankFields(query.q);
    itemsQuery = Product.aggregate([
      { $match: filter },
      { $addFields: rankFields },
      { $sort: { searchRank: -1, popularity: -1, createdAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]);
  }
  const [items, total] = await Promise.all([
    itemsQuery,
    Product.countDocuments(filter),
  ]);
  return paged(items, total, page, limit);
}

export async function getProductById(idOrSlug) {
  const lookup = idOrSlug.match(/^[a-f\d]{24}$/i)
    ? { _id: idOrSlug }
    : { slug: idOrSlug };
  const product = await Product.findOne(lookup);
  if (!product || !product.isActive)
    throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");
  return product;
}

export async function createProduct(payload) {
  const slug = slugify(payload.name, { lower: true, strict: true });
  const product = await Product.create({ ...payload, slug });
  publishInventoryChange({
    action: "product.created",
    productId: String(product._id),
    stock: product.stock,
    isActive: product.isActive,
  });
  return product;
}

export async function updateProduct(id, payload) {
  if (payload.name)
    payload.slug = slugify(payload.name, { lower: true, strict: true });
  const product = await Product.findByIdAndUpdate(id, payload, {
    new: true,
    runValidators: true,
  });
  if (!product)
    throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");
  publishInventoryChange({
    action: "product.updated",
    productId: String(product._id),
    stock: product.stock,
    isActive: product.isActive,
  });
  return product;
}

export async function deleteProduct(id) {
  const product = await Product.findByIdAndUpdate(
    id,
    { isActive: false },
    { new: true },
  );
  if (!product)
    throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");
  publishInventoryChange({
    action: "product.archived",
    productId: String(product._id),
    stock: product.stock,
    isActive: product.isActive,
  });
  return product;
}

export async function listCategories(options = {}) {
  const filter = options.includeInactive ? {} : { isActive: true };
  return Category.find(filter).sort({ sortOrder: 1, name: 1 });
}

export async function createCategory(payload) {
  return Category.create(payload);
}

export async function updateCategory(id, payload) {
  const category = await Category.findByIdAndUpdate(id, payload, {
    new: true,
    runValidators: true,
  });
  if (!category)
    throw new AppError("Category not found", 404, "CATEGORY_NOT_FOUND");
  return category;
}
