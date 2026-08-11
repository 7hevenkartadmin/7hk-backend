import { z } from "zod";

export const listProductsSchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  featured: z.coerce.boolean().optional(),
  includeInactive: z.coerce.boolean().optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  sort: z
    .enum([
      "popularity",
      "price_asc",
      "price_desc",
      "discount",
      "newest",
      "name_asc",
      "stock_asc",
    ])
    .default("popularity"),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export const productSchema = z.object({
  name: z.string().min(2).max(160),
  description: z.string().max(1000).default(""),
  category: z.string().min(2).max(80),
  brand: z.string().max(80).default(""),
  image: z.string().url().optional().or(z.literal("")).default(""),
  gallery: z.array(z.string().url()).default([]),
  mrp: z.number().min(0),
  price: z.number().min(0),
  discount: z.number().min(0).max(100).default(0),
  unit: z.string().min(1).max(40),
  stock: z.number().int().min(0).default(0),
  sku: z.string().min(2).max(60),
  barcode: z
    .object({
      value: z.string().max(80).optional(),
      format: z.string().max(40).default("EAN-13"),
      source: z.string().max(40).default("client"),
    })
    .optional(),
  isFeatured: z.boolean().default(false),
  isActive: z.boolean().default(true),
  popularity: z.number().default(0),
  taxRate: z.number().min(0).max(100).default(0),
});

export const categorySchema = z.object({
  name: z.string().min(2).max(80),
  slug: z.string().min(2).max(100),
  icon: z.string().max(60).default("ShoppingBasket"),
  image: z.string().url().optional().or(z.literal("")).default(""),
  isActive: z.boolean().default(true),
  sortOrder: z.number().default(0),
});
