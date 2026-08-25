import { Router } from 'express';
import { created, ok } from '../../shared/utils/apiResponse.js';
import { asyncHandler } from '../../shared/utils/asyncHandler.js';
import { validate } from '../../shared/validation/validate.js';
import { authorize, requireAuth } from '../auth/auth.middleware.js';
import { audit } from '../audit/audit.service.js';
import { categorySchema, listProductsSchema, productSchema, searchSuggestionsSchema } from './catalog.validation.js';
import { createCategory, createProduct, deleteProduct, getProductById, getProductRecommendations, listCategories, listHomepageShelves, listProducts, searchSuggestions, updateCategory, updateProduct } from './catalog.service.js';
import { Product } from './product.model.js';
import { Category } from './category.model.js';
import { catalogImageUpload } from './catalog-upload.middleware.js';
import { AppError } from '../../shared/utils/AppError.js';
import { deleteCatalogImage, uploadCatalogImage } from './cloudinary-image.service.js';
import { isAndroidRequest } from '../../shared/middlewares/clientPlatform.js';

export const catalogRoutes = Router();

function publicCatalogOptions(req) {
  return { excludePaanCorner: isAndroidRequest(req) };
}

catalogRoutes.get('/products', validate(listProductsSchema, 'query'), asyncHandler(async (req, res) => {
  req.query.limit = Math.min(req.query.limit || 15, 15);
  ok(res, await listProducts(req.query, publicCatalogOptions(req)), 'Products loaded');
}));

catalogRoutes.get('/home', asyncHandler(async (req, res) => {
  ok(res, await listHomepageShelves(req.query.limit, publicCatalogOptions(req)), 'Homepage catalog loaded');
}));

catalogRoutes.get('/search/suggestions', validate(searchSuggestionsSchema, 'query'), asyncHandler(async (req, res) => {
  ok(res, await searchSuggestions(req.query, publicCatalogOptions(req)), 'Search suggestions loaded');
}));

catalogRoutes.get('/products/:idOrSlug/recommendations', asyncHandler(async (req, res) => {
  ok(res, await getProductRecommendations(req.params.idOrSlug, req.query.limit, publicCatalogOptions(req)), 'Product recommendations loaded');
}));

catalogRoutes.get('/products/:idOrSlug', asyncHandler(async (req, res) => {
  ok(res, { product: await getProductById(req.params.idOrSlug, publicCatalogOptions(req)) }, 'Product loaded');
}));

catalogRoutes.get('/categories', asyncHandler(async (req, res) => {
  ok(res, { categories: await listCategories(publicCatalogOptions(req)) }, 'Categories loaded');
}));

catalogRoutes.get('/admin/categories', requireAuth, authorize('admin', 'manager'), asyncHandler(async (_req, res) => {
  ok(res, { categories: await listCategories({ includeInactive: true }) }, 'Admin categories loaded');
}));

catalogRoutes.get('/admin/products', requireAuth, authorize('admin', 'manager'), validate(listProductsSchema, 'query'), asyncHandler(async (req, res) => {
  req.query.limit = Math.min(req.query.limit || 20, 50);
  ok(res, await listProducts(req.query, { includeInactive: req.query.includeInactive !== false, exposeInventory: true }), 'Admin products loaded');
}));

catalogRoutes.use(requireAuth, authorize('admin', 'manager'));

catalogRoutes.post('/uploads/images', catalogImageUpload, asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('Image file is required', 422, 'IMAGE_REQUIRED');
  const image = await uploadCatalogImage(req.file, { kind: req.body.kind || 'product', actorId: req.user._id });
  created(res, { image }, 'Image uploaded');
}));

catalogRoutes.delete('/uploads/images', asyncHandler(async (req, res) => {
  await deleteCatalogImage(req.body.publicId);
  ok(res, {}, 'Image deleted');
}));

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

catalogRoutes.delete('/categories/:id', asyncHandler(async (req, res) => {
  const before = await Category.findById(req.params.id);
  const category = await updateCategory(req.params.id, { isActive: false });
  await audit({ req, action: 'category.archive', entityType: 'Category', entityId: category._id, before, after: category });
  ok(res, { category }, 'Category and linked catalog items archived');
}));
