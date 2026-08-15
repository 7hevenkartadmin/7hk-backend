import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { fileURLToPath } from "url";
import "dotenv/config";

// ============================================================
// PATHS
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CATEGORY_FILE = path.join(__dirname, "categories.json");

const PRODUCT_FILE = path.join(__dirname, "products.json");

// ============================================================
// DATABASE
// ============================================================

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

if (!MONGODB_URI) {
  throw new Error("Missing MONGODB_URI or MONGO_URI in .env");
}

// ============================================================
// HELPERS
// ============================================================

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found:\n${filePath}`);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON:\n${filePath}\n${error.message}`);
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("");
  console.log("========================================");
  console.log("  7HEVENKART CATALOG RESET + SEED");
  console.log("========================================");
  console.log("");

  // ==========================================================
  // READ FILES
  // ==========================================================

  const categoryData = readJson(CATEGORY_FILE);

  const productData = readJson(PRODUCT_FILE);

  if (!Array.isArray(categoryData)) {
    throw new Error("categories.json must contain an array");
  }

  if (!Array.isArray(productData)) {
    throw new Error("products.json must contain an array");
  }

  console.log(`Categories in JSON : ${categoryData.length}`);

  console.log(`Products in JSON   : ${productData.length}`);

  console.log("");

  // ==========================================================
  // CONNECT
  // ==========================================================

  await mongoose.connect(MONGODB_URI);

  const db = mongoose.connection.db;

  const categoriesCollection = db.collection("categories");

  const productsCollection = db.collection("products");

  console.log("✓ Connected to MongoDB");

  console.log(`  Database: ${db.databaseName}`);

  console.log("");

  // ==========================================================
  // RESET CATALOG
  // ==========================================================

  console.log("Deleting existing catalog...");

  const deletedProducts = await productsCollection.deleteMany({});

  const deletedCategories = await categoriesCollection.deleteMany({});

  console.log(`✓ Deleted products   : ${deletedProducts.deletedCount}`);

  console.log(`✓ Deleted categories : ${deletedCategories.deletedCount}`);

  console.log("");

  // ==========================================================
  // CATEGORY MAPS
  // ==========================================================
  //
  // parent slug:
  //
  // biscuits-cookies
  //       ↓
  // ObjectId
  //
  // subcategory slug:
  //
  // sweet-biscuits
  //       ↓
  // ObjectId
  //
  // ==========================================================

  const categoryBySlug = new Map();

  const subcategoryBySlug = new Map();

  // ==========================================================
  // CREATE ROOT CATEGORIES
  // ==========================================================

  console.log("Creating root categories...");

  const rootCategories = categoryData.filter((category) => !category.parent);

  for (const categoryDataItem of rootCategories) {
    const rootDocument = {
      name: categoryDataItem.name,
      slug: categoryDataItem.slug,
      description: categoryDataItem.description || "",
      icon: categoryDataItem.icon || "ShoppingBasket",
      image: categoryDataItem.image || "",
      parent: null,
      isActive: categoryDataItem.isActive !== false,
      sortOrder: categoryDataItem.sortOrder || 0,
    };

    const result = await categoriesCollection.insertOne(rootDocument);

    categoryBySlug.set(categoryDataItem.slug, result.insertedId);

    console.log(`✓ ROOT: ${categoryDataItem.name}`);
  }

  console.log("");

  // ==========================================================
  // CREATE SUBCATEGORIES
  // ==========================================================

  console.log("Creating subcategories...");

  let subcategoryCount = 0;

  for (const categoryDataItem of rootCategories) {
    const parentId = categoryBySlug.get(categoryDataItem.slug);

    if (!parentId) {
      throw new Error(
        `Parent category ID not found for ${categoryDataItem.slug}`,
      );
    }

    const subcategories = categoryDataItem.subcategories || [];

    for (const subcategory of subcategories) {
      const existing = subcategoryBySlug.get(subcategory.slug);

      if (existing) {
        throw new Error(`Duplicate subcategory slug: ${subcategory.slug}`);
      }

      const subcategoryDocument = {
        name: subcategory.name,
        slug: subcategory.slug,
        description: subcategory.description || "",
        icon: subcategory.icon || "ShoppingBasket",
        image: subcategory.image || "",
        parent: parentId,
        isActive: subcategory.isActive !== false,
        sortOrder: subcategory.sortOrder || 0,
      };

      const result = await categoriesCollection.insertOne(subcategoryDocument);

      subcategoryBySlug.set(subcategory.slug, result.insertedId);

      subcategoryCount++;

      console.log(`   └─ ${subcategory.name}`);
    }
  }

  console.log("");

  console.log(`✓ Root categories   : ${rootCategories.length}`);

  console.log(`✓ Subcategories     : ${subcategoryCount}`);

  console.log(
    `✓ Total categories  : ${rootCategories.length + subcategoryCount}`,
  );

  console.log("");

  // ==========================================================
  // PREPARE PRODUCTS
  // ==========================================================

  console.log("Resolving product category references...");

  const productsToInsert = [];

  const missingCategories = [];
  const missingSubcategories = [];
  const invalidParentRelations = [];

  for (const sourceProduct of productData) {
    const categoryRef = categoryBySlug.get(sourceProduct.categorySlug);

    const subcategoryRef = subcategoryBySlug.get(sourceProduct.subcategorySlug);

    // --------------------------------------------------------
    // CATEGORY VALIDATION
    // --------------------------------------------------------

    if (!categoryRef) {
      missingCategories.push({
        product: sourceProduct.name,
        slug: sourceProduct.categorySlug,
      });

      continue;
    }

    // --------------------------------------------------------
    // SUBCATEGORY VALIDATION
    // --------------------------------------------------------

    if (!subcategoryRef) {
      missingSubcategories.push({
        product: sourceProduct.name,
        slug: sourceProduct.subcategorySlug,
      });

      continue;
    }

    // --------------------------------------------------------
    // VERIFY PARENT → CHILD RELATIONSHIP
    // --------------------------------------------------------

    const subcategory = await categoriesCollection.findOne({
      _id: subcategoryRef,
    });

    if (
      !subcategory ||
      !subcategory.parent ||
      String(subcategory.parent) !== String(categoryRef)
    ) {
      invalidParentRelations.push({
        product: sourceProduct.name,
        category: sourceProduct.categorySlug,
        subcategory: sourceProduct.subcategorySlug,
      });

      continue;
    }

    // --------------------------------------------------------
    // CREATE PRODUCT
    // --------------------------------------------------------

    const product = {
      ...sourceProduct,

      categoryRef,
      subcategoryRef,
    };

    // These are seed-only fields.
    // They are not part of your Product schema.

    delete product.categorySlug;

    delete product.subcategorySlug;

    delete product._id;

    productsToInsert.push(product);
  }

  // ==========================================================
  // VALIDATION ERRORS
  // ==========================================================

  if (
    missingCategories.length ||
    missingSubcategories.length ||
    invalidParentRelations.length
  ) {
    console.log("");
    console.log("========================================");

    console.log("❌ CATEGORY VALIDATION FAILED");

    console.log("========================================");

    if (missingCategories.length) {
      console.log("");
      console.log("Missing categories:");

      for (const item of missingCategories) {
        console.log(`  ${item.product} → ${item.slug}`);
      }
    }

    if (missingSubcategories.length) {
      console.log("");
      console.log("Missing subcategories:");

      for (const item of missingSubcategories) {
        console.log(`  ${item.product} → ${item.slug}`);
      }
    }

    if (invalidParentRelations.length) {
      console.log("");
      console.log("Invalid parent relationships:");

      for (const item of invalidParentRelations) {
        console.log(
          `  ${item.product}: ${item.category} → ${item.subcategory}`,
        );
      }
    }

    throw new Error("Fix category relationships before inserting products.");
  }

  console.log(`✓ Resolved ${productsToInsert.length} products`);

  console.log("");

  // ==========================================================
  // INSERT PRODUCTS
  // ==========================================================

  console.log("Inserting products...");

  if (productsToInsert.length) {
    await productsCollection.insertMany(productsToInsert, {
      ordered: true,
    });
  }

  console.log(`✓ Inserted products: ${productsToInsert.length}`);

  // ==========================================================
  // VERIFY
  // ==========================================================

  const finalCategories = await categoriesCollection.countDocuments();

  const finalProducts = await productsCollection.countDocuments();

  const productsWithoutCategoryRef = await productsCollection.countDocuments({
    categoryRef: {
      $exists: false,
    },
  });

  const productsWithoutSubcategoryRef = await productsCollection.countDocuments(
    {
      subcategoryRef: {
        $exists: false,
      },
    },
  );

  console.log("");

  console.log("========================================");

  console.log("  SEED COMPLETED");

  console.log("========================================");

  console.log("");

  console.log(`Categories in DB : ${finalCategories}`);

  console.log(`Products in DB   : ${finalProducts}`);

  console.log("");

  console.log(`Missing categoryRef    : ${productsWithoutCategoryRef}`);

  console.log(`Missing subcategoryRef : ${productsWithoutSubcategoryRef}`);

  console.log("");

  if (productsWithoutCategoryRef === 0 && productsWithoutSubcategoryRef === 0) {
    console.log("✓ All products have valid categoryRef");

    console.log("✓ All products have valid subcategoryRef");
  }

  console.log("");

  console.log("✓ Catalog reset completed.");

  console.log("✓ No other collections were modified.");

  console.log("");

  await mongoose.disconnect();
}

// ============================================================
// ERROR HANDLER
// ============================================================

main().catch(async (error) => {
  console.error("");

  console.error("========================================");

  console.error("  ❌ SEED FAILED");

  console.error("========================================");

  console.error("");

  console.error(error.message || error);

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});
