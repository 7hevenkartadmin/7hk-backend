import { Router } from 'express';
import { created, ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { audit } from '../audit/audit.service.js';
import { categorySchema, listProductsSchema, productSchema, searchSuggestionsSchema } from './catalog.validation.js';
import { createCategory, createProduct, deleteProduct, getProductById, listCategories, listProducts, searchSuggestions, updateCategory, updateProduct } from './catalog.service.js';
import { Product } from './product.model.js';
import { Category } from './category.model.js';

export const catalogRoutes = Router();

catalogRoutes.get('/products', validate(listProductsSchema, 'query'), asyncHandler(async (req, res) => {
  ok(res, await listProducts(req.query), 'Products loaded');
}));

catalogRoutes.get('/search/suggestions', validate(searchSuggestionsSchema, 'query'), asyncHandler(async (req, res) => {
  ok(res, await searchSuggestions(req.query), 'Search suggestions loaded');
}));

catalogRoutes.get('/products/:idOrSlug', asyncHandler(async (req, res) => {
  ok(res, { product: await getProductById(req.params.idOrSlug) }, 'Product loaded');
}));

catalogRoutes.get('/categories', asyncHandler(async (_req, res) => {
  ok(res, { categories: await listCategories() }, 'Categories loaded');
}));

catalogRoutes.get('/admin/categories', requireAuth, authorize('admin', 'manager'), asyncHandler(async (_req, res) => {
  ok(res, { categories: await listCategories({ includeInactive: true }) }, 'Admin categories loaded');
}));

catalogRoutes.get('/admin/products', requireAuth, authorize('admin', 'manager'), validate(listProductsSchema, 'query'), asyncHandler(async (req, res) => {
  ok(res, await listProducts(req.query, { includeInactive: req.query.includeInactive !== false }), 'Admin products loaded');
}));

catalogRoutes.use(requireAuth, authorize('admin', 'manager'));

catalogRoutes.post('/products', validate(productSchema), asyncHandler(async (req, res) => {
  const product = await createProduct(req.body);
  await audit({ req, action: 'product.create', entityType: 'Product', entityId: product._id, after: product });
  created(res, { product }, 'Product created');
}));

catalogRoutes.patch('/products/:id', validate(productSchema.partial()), asyncHandler(async (req, res) => {
  const before = await Product.findById(req.params.id);
  const product = await updateProduct(req.params.id, req.body);
  await audit({ req, action: 'product.update', entityType: 'Product', entityId: product._id, before, after: product });
  ok(res, { product }, 'Product updated');
}));

catalogRoutes.delete('/products/:id', asyncHandler(async (req, res) => {
  const before = await Product.findById(req.params.id);
  const product = await deleteProduct(req.params.id);
  await audit({ req, action: 'product.archive', entityType: 'Product', entityId: product._id, before, after: product });
  ok(res, { product }, 'Product archived');
}));

catalogRoutes.post('/categories', validate(categorySchema), asyncHandler(async (req, res) => {
  const category = await createCategory(req.body);
  await audit({ req, action: 'category.create', entityType: 'Category', entityId: category._id, after: category });
  created(res, { category }, 'Category created');
}));

catalogRoutes.patch('/categories/:id', validate(categorySchema.partial()), asyncHandler(async (req, res) => {
  const before = await Category.findById(req.params.id);
  const category = await updateCategory(req.params.id, req.body);
  await audit({ req, action: 'category.update', entityType: 'Category', entityId: category._id, before, after: category });
  ok(res, { category }, 'Category updated');
}));
