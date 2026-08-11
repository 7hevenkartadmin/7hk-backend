import mongoose from "mongoose";

const barcodeSchema = new mongoose.Schema(
  {
    value: { type: String, trim: true },
    format: { type: String, trim: true, default: "EAN-13" },
    source: { type: String, trim: true, default: "client" },
  },
  { _id: false },
);

const productSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true, index: "text" },
    slug: {
      type: String,
      trim: true,
      unique: true,
      index: true,
      required: true,
    },
    description: { type: String, trim: true, default: "" },
    category: { type: String, trim: true, required: true, index: true },
    categoryRef: { type: mongoose.Schema.Types.ObjectId, ref: "Category" },
    brand: { type: String, trim: true, default: "" },
    image: { type: String, trim: true, default: "" },
    gallery: [{ type: String, trim: true }],
    mrp: { type: Number, min: 0, required: true },
    price: { type: Number, min: 0, required: true },
    discount: { type: Number, min: 0, max: 100, default: 0 },
    unit: { type: String, trim: true, required: true },
    rating: { type: Number, min: 0, max: 5, default: 0 },
    ratingCount: { type: Number, min: 0, default: 0 },
    stock: { type: Number, min: 0, default: 0, index: true },
    reservedStock: { type: Number, min: 0, default: 0 },
    sku: { type: String, trim: true, unique: true, required: true },
    barcode: barcodeSchema,
    isFeatured: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true, index: true },
    popularity: { type: Number, default: 0 },
    taxRate: { type: Number, min: 0, max: 100, default: 0 },
  },
  { timestamps: true },
);

productSchema.index({
  name: "text",
  description: "text",
  brand: "text",
  sku: "text",
  "barcode.value": "text",
});

export const Product = mongoose.model("Product", productSchema);
