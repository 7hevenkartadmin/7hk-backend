import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { Product } from '../modules/catalog/product.model.js';

await connectDatabase();

let migrated = 0;
const cursor = Product.find().cursor();
for await (const product of cursor) {
  // Product validation creates a default SKU for legacy single-pack products,
  // preserves existing variant IDs, and recalculates inventory summaries.
  await product.save();
  migrated += 1;
}

console.log(`Inventory migration complete: ${migrated} products normalized`);
await disconnectDatabase();
