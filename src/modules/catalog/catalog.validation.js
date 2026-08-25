import { z } from 'zod';

export const listProductsSchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  featured: z.coerce.boolean().optional(),
  includeInactive: z.coerce.boolean().optional(),
  active: z.enum(['all', 'active', 'inactive']).optional(),
  stockStatus: z.enum(['all', 'low', 'out']).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  sort: z.enum(['popularity', 'price_asc', 'price_desc', 'discount', 'newest', 'name_asc', 'stock_asc']).default('popularity'),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export const searchSuggestionsSchema = z.object({
  q: z.string().trim().min(2).max(120),
  category: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(10).default(6),
});

const barcodeSchema = z.object({
  value: z.string().max(80).optional(),
  format: z.string().max(40).default('EAN-13'),
  source: z.string().max(40).default('client'),
});

const variantSchema = z.object({
  _id: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  title: z.string().min(1).max(80),
  unit: z.string().min(1).max(40),
  barcode: barcodeSchema.optional(),
  mrp: z.number().min(0),
  price: z.number().min(0),
  stock: z.number().int().min(0).default(0),
  images: z.array(z.string().url()).default([]),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
}).refine((variant) => variant.price <= variant.mrp, { message: 'Variant price cannot exceed MRP', path: ['price'] });

export const productSchema = z.object({
  name: z.string().min(2).max(160),
  description: z.string().max(1000).default(''),
  category: z.string().min(2).max(80),
  categoryRef: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
  subcategoryRef: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
  brand: z.string().max(80).default(''),
  image: z.string().url().optional().or(z.literal('')).default(''),
  gallery: z.array(z.string().url()).default([]),
  mrp: z.number().min(0),
  price: z.number().min(0),
  discount: z.number().min(0).max(100).default(0),
  unit: z.string().min(1).max(40),
  stock: z.number().int().min(0).default(0),
  barcode: z.object({
    value: z.string().max(80).optional(),
    format: z.string().max(40).default('EAN-13'),
    source: z.string().max(40).default('client'),
  }).optional(),
  variants: z.array(variantSchema).max(30).default([]),
  highlights: z.array(z.string().min(1).max(120)).max(12).default([]),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  manufacturer: z.string().max(120).default(''),
  countryOfOrigin: z.string().max(80).default('India'),
  shelfLife: z.string().max(80).default(''),
  storageInstructions: z.string().max(300).default(''),
  isVegetarian: z.boolean().default(true),
  isFeatured: z.boolean().default(false),
  isActive: z.boolean().default(true),
  popularity: z.number().default(0),
  taxRate: z.number().min(0).max(100).default(0),
});

export const categorySchema = z.object({
  name: z.string().min(2).max(80),
  slug: z.string().min(2).max(100),
  icon: z.string().max(60).default('ShoppingBasket'),
  image: z.string().url().optional().or(z.literal('')).default(''),
  description: z.string().max(500).default(''),
  parent: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
  isActive: z.boolean().default(true),
  sortOrder: z.number().default(0),
});
