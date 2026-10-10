// A one-off catalog backfill, not a classifier for products created by admins.
// Headings are deliberately broad when the supplier's tariff item is unavailable.
export const CATALOG_TAX_ESTIMATE_VERSION = 'catalog-estimate-2026-10-10-v1';
export const CATALOG_TAX_SOURCES = {
  goods: 'https://courier.cbic.gov.in/ECCS/advisory/2025/NOTIFICATION%20NO.%209_2025-INTEGRATED%20TAX%20%28RATE%29%20-1759486719.pdf',
  exempt: 'https://cbic-gst.gov.in/hindi/gst-goods-services-rates.html',
  beverages: 'https://gstcouncil.gov.in/sites/default/files/2026-05/newsletter_april_issue.pdf',
  tobacco: 'https://gstcouncil.gov.in/sites/default/files/2026-01/monthly_newsletter_december_2025_1.pdf',
};

const groupDefaults = {
  'Crackers & Savoury Biscuits': ['1905', 5],
  'Mixtures & Namkeen': ['210690', 5],
  'Glucose & Energy Drinks': ['210690', 5],
  'Rusks & Toast': ['19054000', 5],
  'Dal & Nut Snacks': ['210690', 5],
  'Bhujia & Sev': ['210690', 5],
  'Pasta & Macaroni': ['1902', 5],
  'Ketchup & Sauces': ['2103', 5],
  Pickles: ['2001', 5],
  'Vermicelli & Sevai': ['1902', 5],
  'Chyawanprash & Immunity': ['3004', 5],
  'Face Creams': ['3304', 18],
  'Ground Spices': ['0910', 5],
  'Sweet Biscuits': ['1905', 5],
  'Cream & Sandwich Biscuits': ['1905', 5],
  'Seeds & Trail Mix': ['1207', 5],
  'Ready-to-Eat Savouries': ['210690', 5],
  'Dates & Anjeer': ['0804', 5],
  'Dessert & Instant Mixes': ['1901', 5],
  'Rice & Basmati Rice': ['1006', 5],
  'Atta & Wheat Flour': ['1101', 5],
  'Moisturizers & Lotions': ['3304', 18],
  Makhana: ['0802', 5],
  'Chips & Crisps': ['2008', 5],
  'Sugar-Free & Special Nutrition': ['210690', 5],
  'Breakfast Cereals': ['1904', 5],
  'Cashews & Pistachios': ['0801', 5],
  'Infant Formula': ['190110', 5],
  'Digestive & Health Biscuits': ['1905', 5],
  'Raisins & Dried Fruits': ['0806', 5],
  'Almonds & Walnuts': ['0802', 5],
  'Instant Noodles': ['1902', 5],
  'Chutneys & Dips': ['2103', 5],
  'Jams & Spreads': ['2007', 5],
  'Growing-Up Nutrition': ['1901', 5],
  'Coffee & Tea': ['0902', 5],
  'Oats & Instant Breakfast': ['1104', 5],
  'Infant Cereals': ['190110', 5],
  'Mother Nutrition': ['1901', 5],
  'Sharbat & Syrups': ['210690', 5],
  'Blended Masalas': ['2103', 5],
  'Deodorants & Body Sprays - Attar': ['3303', 18],
  'Soya & Extruded Snacks': ['1905', 5],
  Cigarettes: ['2402', 40],
  'Rolling Papers & Smoking Accessories': ['4813', 18],
  'Detergent Powder': ['3402', 18],
  'Chocolate Gift Box': ['1806', 5],
  'Follow Up Formula': ['190110', 5],
  'traditional-indian-sweets': ['210690', 5],
  'Cake-Slice & Wafers': ['1905', 5],
  Condoms: ['40141000', 0],
  'Kesar & Saffron': ['0910', 5],
  'Vinegar & Continental Sauce': ['2103', 5],
  'Canned & Preserved Food': ['2005', 5],
  'Health Drink Powders': ['1901', 5],
  'Besan & Other Flours': ['1106', 5],
  'Sugar & Sweeteners': ['1701', 5],
  'Dal & Pulses': ['0713', 5],
  Papad: ['19059040', 0],
  'Grains & Millets': ['1103', 5],
  'Cooking Oil': ['1517', 5],
  Salt: ['2501', 0],
  'Food Colours': ['3204', 18],
  'Coco & Chocolate Powder': ['1806', 5],
  'Milk Powder': ['0402', 5],
  'Agarbatti / Incense Sticks': ['33074100', 5],
  'Til Oil': ['151550', 5],
  'Cow Ghee': ['0405', 5],
  'Camphor / Kapur': ['29142100', 18],
  'Hair Color & Hair Dye': ['3305', 18],
  'Baby Message Oil & Baby Face Powder': ['3304', 18],
  'Gulabari Rose Water': ['3303', 18],
  'Soap & Baby Soap': ['3401', 5],
  'Hawan Samagri': ['33074100', 5],
  'Fabric Whitener / Post-Wash Utilities': ['3402', 18],
  'Baby Cream': ['3304', 18],
  'Cold & Cough Relief': ['3004', 5],
  'Sanitary Pads': ['96190010', 0],
  'Dishwash & Dishwash Bar': ['3402', 18],
  Handwash: ['3401', 18],
  'Liquid Detergent': ['3402', 18],
  'Fabric Conditioners': ['3809', 18],
  'Antiseptic & Disinfectant Liquids': ['3808', 18],
  'Sawer Gel': ['3401', 18],
  'Toilet & Bathroom Cleaner': ['3402', 18],
  'Pest Control & Insect Killer': ['3808', 18],
  'Glass & Surface Cleaner': ['3402', 18],
  'Mosquito Coil': ['3808', 18],
  'Baby Feeding Bottle': ['3926', 5],
  'Baby Powder Puff': ['96162000', 18],
  'Digestive Tablets & Candy': ['3004', 5],
  'laundry-care-bath-care-soaps': ['3924', 18],
  'Baby Diapers': ['96190030', 5],
  'Chocolate Bars': ['1806', 5],
  Toothpaste: ['3306', 5],
  'Shaving & Grooming': ['8212', 18],
  'Toothbrush & Tongue Cleaner': ['96032100', 5],
  'Mouth Freshener': ['3306', 18],
  'Fruit Juice & Cold Drink And Ors': ['2009', 5],
  'Health and Wellness Oil': ['3305', 5],
  'Shampoo & Conditioner': ['3305', 5],
  'Face Wash & Face Mask': ['3401', 18],
  'Face Powder And Powder  / Compact Powder': ['3304', 5],
  'Cream Cosmetics & Make Up Brush': ['3304', 18],
  'Cosmetics & Skincare And Eye Makeup': ['3304', 18],
  'Shoe Polish': ['3405', 18],
  'Skin Care And Hair Serum': ['3305', 18],
  'Hair Removal Cream & Spray': ['3307', 18],
  'Digestive Health Powder': ['3004', 5],
  Lubricant: ['3307', 18],
};

function estimate(hsnCode, taxRate, reason, source = 'goods', blocked = false) {
  return { hsnCode, taxRate, reason, source: CATALOG_TAX_SOURCES[source], blocked };
}

export function estimateCatalogProductTax(product, subcategoryName) {
  const name = String(product.name || '').toLowerCase().normalize('NFKC');
  const group = String(subcategoryName || '').trim();
  const defaults = groupDefaults[group];
  if (!defaults) return null; // Unknown future catalog groups require an explicit rule.
  const result = (hsn, rate, reason, source) => estimate(hsn, rate, reason, source);
  if (group === 'Cigarettes') return estimate('2402', 40, 'Cigarettes: RSP valuation is not supported; retain the checkout classification block', 'tobacco', true);
  if (['Condoms', 'Sanitary Pads', 'Salt', 'Papad'].includes(group)) return result(...defaults, `${group}: exempt goods; confirm the supplier tariff item`, 'exempt');

  if (['Ground Spices', 'Blended Masalas'].includes(group)) {
    if (/bread crumbs|panko/.test(name)) return result('1905', 5, 'Bread crumbs, rather than spice mix');
    if (/custard/.test(name)) return result('1901', 5, 'Prepared custard mix');
    if (/almond/.test(name)) return result('0802', 5, 'Almonds, rather than spice mix');
    if (/breakfast mix/.test(name)) return result('2008', 5, 'Assumed ready-to-eat nut/seed breakfast mix; verify ingredients');
    if (/hing|heeng|asafoetida/.test(name)) return result('1301', 5, 'Compounded asafoetida');
    if (/chilli|mirch|pepper/.test(name)) return result('0904', 5, 'Dried pepper or chilli');
    if (/coriander|dhania|jeera|cumin|saunf|fennel/.test(name)) return result('0909', 5, 'Coriander, cumin or fennel, not sowing seed');
    if (/cardamom|elaichi|nutmeg|mace/.test(name)) return result('0908', 5, 'Cardamom, nutmeg or mace');
    if (/kas[ou]ri methi|kasoori|methi dana|nigella|mangraila|oregano|panch phoron|turmeric|haldi|amchoor|tej patta|whole|khara|garam masala/.test(name)) return result('0910', 5, 'Dried spice or blend of spices; verify the precise tariff item');
  }
  if (group === 'Glucose & Energy Drinks' || group === 'Fruit Juice & Cold Drink And Ors') {
    if (/red bull|redbull|hell energy/.test(name)) return result('220299', 40, 'Caffeinated energy beverage; use the supplier 2026 tariff item', 'beverages');
    if (/\bors\b|prolyte/.test(name)) return result('3004', 5, 'Assumed licensed oral rehydration salt preparation; verify label');
    if (/badam shakers|milk/.test(name)) return result('220299', 5, 'Non-carbonated milk beverage; use the supplier 2026 tariff item', 'beverages');
  }
  if (group === 'Ketchup & Sauces' && /tomato puree/.test(name)) return result('2002', 5, 'Preserved tomato puree');
  if (group === 'Vermicelli & Sevai' && /mix|payasam|kheer/.test(name)) return result('1901', 5, 'Prepared dessert mix, rather than plain vermicelli');
  if (group === 'Oats & Instant Breakfast' && /masala|instant/.test(name)) return result('1904', 5, 'Prepared cereal breakfast');
  if (group === 'Seeds & Trail Mix') {
    if (/roast|rosted|mix/.test(name)) return result('2008', 5, 'Assumed prepared edible seed/nut mix; verify composition');
    if (/sunflower/.test(name)) return result('1206', 5, 'Edible sunflower seeds, not sowing seed');
    if (/flax/.test(name)) return result('1204', 5, 'Edible linseed, not sowing seed');
  }
  if (group === 'Cashews & Pistachios') {
    if (/roast|salt/.test(name)) return result('2008', 5, 'Roasted or salted nuts');
    if (/pistach/.test(name)) return result('0802', 5, 'Dried pistachios');
  }
  if (group === 'Raisins & Dried Fruits' && /plum/.test(name)) return result('0813', 5, 'Dried plums');
  if (group === 'Atta & Wheat Flour' && /navrat/.test(name)) return result('1102', 5, 'Assumed mixed cereal flour; verify ingredients');
  if (group === 'Sugar-Free & Special Nutrition' && /juice/.test(name)) return result('2009', 5, 'Vegetable/herbal juice; verify beverage versus medicinal label');
  if (group === 'Coffee & Tea') {
    if (/coffee/.test(name)) return result('210111', 5, 'Instant coffee');
    if (/ayurveda|blue tea|detox/.test(name)) return result('1211', 5, 'Assumed dried herbal infusion; verify composition versus Camellia tea');
  }
  if ((group === 'Cake-Slice & Wafers' && /kinder joy/.test(name)) || (group === 'Growing-Up Nutrition' && /bournvita/.test(name)) || (group === 'Sharbat & Syrups' && /choco/.test(name))) return result('1806', 5, 'Cocoa-containing food preparation');
  if (group === 'Vinegar & Continental Sauce' && /vinegar/.test(name)) return result('2209', 18, 'Vinegar');
  if (group === 'Canned & Preserved Food') {
    if (/mushroom/.test(name)) return result('2003', 5, 'Preserved mushrooms');
    if (/soya chaap/.test(name)) return result('2106', 5, 'Texturised vegetable protein preparation');
  }
  if (group === 'Besan & Other Flours') {
    if (/custard/.test(name)) return result('1901', 5, 'Prepared custard mix');
    if (/soda/.test(name)) return result('283630', 18, 'Sodium bicarbonate, rather than prepared baking powder');
    if (/sooji|suji/.test(name)) return result('1103', 5, 'Packaged cereal meal');
    if (/sattu/.test(name)) return result('1106', 5, 'Assumed roasted gram flour; verify label');
  }
  if (group === 'Sugar & Sweeteners') {
    if (/honey/.test(name)) return result('0409', 5, 'Packaged natural honey; promotional free rice is also 5% if packaged');
    if (/sugar free|sweetener/.test(name)) return result('210690', 5, 'Prepared sweetener/diabetic food; verify composition');
    if (/nakuldana/.test(name)) return result('1704', 5, 'Sugar confectionery');
  }
  if (group === 'Grains & Millets') {
    if (/soya chunk/.test(name)) return result('2106', 5, 'Texturised vegetable protein');
    if (/sabudana/.test(name)) return result('1903', 5, 'Tapioca/sago');
  }
  if (group === 'Cooking Oil') {
    if (/mustard|kac[hc]hi ghani|kachi ghani/.test(name)) return result('1514', 5, 'Mustard oil');
    if (/soya|soyabean/.test(name)) return result('1507', 5, 'Soya-bean oil');
  }
  if (group === 'Agarbatti / Incense Sticks') {
    if (/shining powder/.test(name)) return result('3405', 18, 'Metal polishing powder, rather than incense');
    if (/matchbox/.test(name)) return result('36050010', 5, 'Safety matches');
  }
  if (group === 'Hair Color & Hair Dye' && /100% pure henna|herbal mehandi/.test(name)) return result('1404', 5, 'Assumed pure henna powder; verify dye additives');
  if (group === 'Deodorants & Body Sprays - Attar' && /deodorant|body spray|\bdeo\b/.test(name)) return result('3307', 18, 'Personal deodorant');
  if (group === 'Baby Message Oil & Baby Face Powder') {
    if (/lal tail/.test(name)) return result('3004', 5, 'Assumed licensed Ayurvedic medicinal baby oil');
    if (/powder/.test(name)) return result('3304', 5, 'Talcum/baby powder');
  }
  if (group === 'Cold & Cough Relief' && /babyrub/.test(name)) return result('3307', 18, 'Assumed non-medicinal baby rub; verify licence and supplier invoice');
  if (group === 'Fabric Conditioners' && /comfort/.test(name)) return result('3402', 18, 'Fabric conditioning preparation');
  if (group === 'Antiseptic & Disinfectant Liquids') {
    if (/alum/.test(name)) return result('283330', 18, 'Alum, rather than disinfectant liquid');
    if (/v wash/.test(name)) return result('3401', 18, 'Liquid intimate wash');
    if (/dettol antiseptic/.test(name)) return result('3004', 5, 'Assumed licensed medicinal antiseptic; verify drug label');
  }
  if (group === 'Toilet & Bathroom Cleaner' && /gonyle/.test(name)) return result('3808', 18, 'Disinfectant floor cleaner');
  if (group === 'Baby Feeding Bottle' && /glass/.test(name)) return result('7013', 18, 'Glass feeding bottle; verify tariff treatment against the supplier invoice');
  if (group === 'Shaving & Grooming') {
    if (/brush/.test(name)) return result('9603', 18, 'Shaving brush');
    if (/foam/.test(name)) return result('3307', 18, 'Pre-shave foam; verify whether supplied as shaving cream');
    if (/cream/.test(name)) return result('3307', 5, 'Shaving cream');
    if (/nail cleanser/.test(name)) return result('3304', 18, 'Nail cleansing/cosmetic preparation');
  }
  if (group === 'Toothbrush & Tongue Cleaner' && /tongue/.test(name)) return result('8214', 18, 'Assumed tongue scraper; verify material and supplier tariff item');
  if (group === 'Health and Wellness Oil') {
    if (/serum/.test(name)) return result('3305', 18, 'Hair serum, rather than hair oil');
    if (/100\s*% pure coconut|pure coconut|anmol gold/.test(name)) return result('1513', 5, 'Pure coconut oil, rather than formulated hair preparation');
    if (/figaro/.test(name)) return result('1509', 5, 'Olive oil');
    if (/castor/.test(name)) return result('1515', 5, 'Castor oil');
    if (/flaxseed|kalonji|neem oil/.test(name)) return result('1515', 5, 'Assumed pure fixed vegetable oil; verify formulation');
    if (/liniment|pain relief|arnica|wheezal|rogan dimage|roghan sukoon|rahat rooh/.test(name)) return result('3004', 5, 'Assumed licensed medicinal oil; verify drug licence');
  }
  if (group === 'Shampoo & Conditioner') {
    if (/conditioner/.test(name)) return result('3305', 18, 'Hair conditioner, rather than shampoo');
    if (/anti.?lice|mediker/.test(name)) return result('3004', 5, 'Assumed medicinal anti-lice treatment');
  }
  if (group === 'Face Wash & Face Mask' && /mask|face pack/.test(name)) return result('3304', 18, 'Cosmetic face mask/pack');
  if (['Moisturizers & Lotions', 'Baby Cream', 'Face Powder And Powder  / Compact Powder', 'Cream Cosmetics & Make Up Brush', 'Cosmetics & Skincare And Eye Makeup'].includes(group)) {
    if (/hydroquinone|tretinoin|trentinoin|mometasone|medisalic|skinshine|elosone|melacare|myfair|skinlite|skinkler|candid dusting|boroline|boroplus|vicco turmeric|medicinal cream|h[a]?pdco|melas alfa|no scars skin|diaper rash|ady crack/.test(name)) return result('3004', 5, 'Assumed licensed medicinal skin preparation; verify drug label');
    if (/make.?up brush|foundation make up brush/.test(name)) return result('9603', 18, 'Make-up brush');
    if (/glycerin/.test(name)) return result('290545', 18, 'Pure glycerol solution');
    if (/wood shine polish/.test(name)) return result('3405', 18, 'Wood polish, rather than skin cream');
    if (/mascara/.test(name)) return result('330420', 18, 'Eye make-up');
    if (/cleansing wipes|remover wipes/.test(name)) return result('3304', 18, 'Assumed impregnated cosmetic cleansing wipes');
  }
  if (group === 'Digestive Health Powder' && /isabgol/.test(name)) return result('1211', 5, 'Dried psyllium husk; verify medicinal versus natural husk label');
  const assumption = `${group}: estimated from product name and subcategory; verify composition, packaging and supplier invoice`;
  return result(...defaults, assumption);
}

export function buildCatalogTaxBackfillPlan(products, categories) {
  const categoriesById = new Map(categories.map((row) => [String(row._id), row]));
  const classifications = products.map((product) => {
    const category = categoriesById.get(String(product.subcategoryRef));
    const proposed = estimateCatalogProductTax(product, category?.name || product.category);
    if (!proposed) throw new Error(`No reviewed catalog rule for ${product._id}: ${category?.name || product.category}`);
    // Retain more-specific saved tariff items when they agree with the broader heading/rate.
    const matches = /^(?:\d{4}|\d{6}|\d{8})$/.test(product.hsnCode || '')
      && product.hsnCode.startsWith(proposed.hsnCode) && product.taxRate === proposed.taxRate;
    const keep = matches && product.taxStatus === 'verified' && !proposed.blocked;
    return { product, category, proposed: { ...proposed, hsnCode: matches ? product.hsnCode : proposed.hsnCode }, keep };
  });
  const categoryChanges = [];
  for (const category of categories.filter((row) => row.parent)) {
    const children = classifications.filter((row) => String(row.product.subcategoryRef) === String(category._id));
    const pairs = new Set(children.map((row) => `${row.proposed.hsnCode}:${row.proposed.taxRate}`));
    if (!children.length || pairs.size !== 1 || children.some((row) => row.proposed.blocked)) continue;
    const { hsnCode, taxRate } = children[0].proposed;
    const missing = !category.hsnCode || category.taxRate === null || category.taxRate === undefined;
    // Correct the known test rate on noodles; preserve other configured admin defaults.
    const noodlesTestRate = category.name === 'Instant Noodles' && category.hsnCode === '1902' && category.taxRate === 12;
    if ((missing || noodlesTestRate) && (category.hsnCode !== hsnCode || category.taxRate !== taxRate)) categoryChanges.push({ id: String(category._id), name: category.name, set: { hsnCode, taxRate } });
  }
  const changedDefaults = new Map(categoryChanges.map((row) => [row.id, row.set]));
  const productChanges = [];
  for (const { product, category, proposed, keep } of classifications) {
    if (keep) continue;
    const defaults = changedDefaults.get(String(category?._id)) || category;
    const taxOrigin = defaults?.hsnCode === proposed.hsnCode && defaults?.taxRate === proposed.taxRate ? 'subcategory' : 'override';
    const set = { hsnCode: proposed.hsnCode, taxRate: proposed.taxRate, taxOrigin,
      taxStatus: proposed.blocked ? 'review' : 'estimated', taxProfile: CATALOG_TAX_ESTIMATE_VERSION,
      taxSource: proposed.source, taxReviewedAt: null, taxReviewReason: proposed.reason };
    if (Object.entries(set).every(([key, value]) => (product[key] ?? null) === value)) continue;
    productChanges.push({ id: String(product._id), name: product.name, subcategory: category?.name || product.category,
      before: { hsnCode: product.hsnCode || '', taxRate: product.taxRate ?? null, taxStatus: product.taxStatus || 'legacy' }, set });
  }
  return { version: CATALOG_TAX_ESTIMATE_VERSION, productChanges, categoryChanges,
    coverage: classifications.map(({ product, proposed, keep }) => ({ id: String(product._id), name: product.name,
      hsnCode: proposed.hsnCode, taxRate: proposed.taxRate, status: keep ? 'verified' : proposed.blocked ? 'review' : 'estimated' })) };
}
