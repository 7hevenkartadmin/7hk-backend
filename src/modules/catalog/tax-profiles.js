// Reviewed against Notification 9/2025; narrowly scoped descriptions only.
export const TAX_SOURCE = 'https://courier.cbic.gov.in/advisory/2025/NOTIFICATION%20NO.%209_2025-INTEGRATED%20TAX%20%28RATE%29%20-1759486719.pdf';
const entries = [
  ['noodles', 'Pasta, noodles and plain vermicelli', '1902', 5, 'I/119'],
  ['biscuits', 'Biscuits, cookies, cakes and wafers (excluding bread and papad)', '1905', 5, 'I/123'],
  ['rusk', 'Rusks and toasted bread', '19054000', 5, 'I/124'],
  ['chocolate', 'Chocolate and cocoa food preparations', '1806', 5, 'I/116'],
  ['confectionery', 'Sugar confectionery without cocoa', '1704', 5, 'I/110'],
  ['sauces', 'Sauces and ketchup', '2103', 5, 'I/139'],
  ['bhujia', 'Namkeen, bhujia and sev', '210690', 5, 'I/143'],
  ['milk-powder', 'Milk powder and condensed milk', '0402', 5, 'I/4'],
  ['ghee', 'Butter and ghee', '0405', 5, 'I/7'],
  ['tea', 'Processed tea (not herbal infusions)', '0902', 5, 'I/34'],
  ['instant-coffee', 'Pure instant coffee extracts', '210111', 5, 'I/135'],
  ['pepper-chilli', 'Dried pepper and chilli', '0904', 5, 'I/36'],
  ['cardamom', 'Cardamom, nutmeg and mace', '0908', 5, 'I/40'],
  ['coriander-cumin', 'Coriander, cumin and fennel spices (not sowing seed)', '0909', 5, 'I/41'],
  ['turmeric', 'Dried turmeric and other spices of heading 0910', '0910', 5, 'I/42'],
  ['shampoo', 'Shampoo and hair oil (not conditioner or serum)', '3305', 5, 'I/245'],
  ['toothpaste', 'Toothpaste', '3306', 5, 'I/246'],
  ['shaving', 'Shaving cream and shaving lotion', '3307', 5, 'I/249'],
  ['soap-bar', 'Toilet soap bars (not liquid soap)', '3401', 5, 'I/251'],
  ['hair-preparation', 'Hair conditioner and hair serum (not medicines)', '3305', 18, 'II/62'],
  ['deodorant', 'Deodorants and depilatory preparations', '3307', 18, 'II/64'],
  ['liquid-soap', 'Liquid hand wash and body wash', '3401', 18, 'II/66'],
  ['detergent', 'Detergents and washing preparations', '3402', 18, 'II/67'],
];
export const taxProfiles = entries.map(([key, name, hsnCode, taxRate, sourceEntry]) => ({
  key, name, hsnCode, taxRate, sourceEntry, sourceUrl: TAX_SOURCE,
  effectiveFrom: '2025-09-22', reviewedOn: '2026-10-10',
}));
export function findTaxProfile(key) { return taxProfiles.find((profile) => profile.key === key); }

// Never infer a classification from a heterogeneous catalogue category alone.
export function suggestExistingProduct(product) {
  const name = String(product.name || '').toLowerCase();
  if (/reay to mix|hand wash powder|banphool|rogan dimage|kesh king|peanut|condom|fabric|hair colou?r|free|infant|baby milk|stage [123]|bournvita|mediker|wheezal|anti.lice|nut cracker|butter biscotti|ghee roasted|medic|ayurvedic|antiseptic|anti.?fungal|ketoconazole|hydroquinone|tretinoin|mometasone|combo|kit|gift|\+/.test(name)) return null;
  const rules = [
    ['noodles', /noodles|macaroni pasta|penne.*pasta|fusilli.*pasta|chowmein/],
    ['rusk', /rusk|ruskit/], ['biscuits', /biscuit|cookies|cracker|wafer/],
    ['chocolate', /chocolate|kinder joy/], ['sauces', /ketchup|tomato sauce|soy sauce|chilli sauce/],
    ['bhujia', /bhujia|\bsev\b/], ['ghee', /\bghee\b/],
    ['milk-powder', /milk powder|condensed milk/],
    ['pepper-chilli', /^(chilli powder|black pepper|chilli flakes)/],
    ['cardamom', /^(black cardamom|small cardamom)/],
    ['coriander-cumin', /^(coriander powder|kaka jeera|saunf)/],
    ['turmeric', /^turmeric powder/],
    ['shampoo', /shampoo|hair oil/], ['toothpaste', /toothpaste/],
    ['shaving', /shaving cream|shaving lotion/],
    ['hair-preparation', /conditioner|hair serum/],
    ['deodorant', /deodorant|hair removal cream|hair removal spray/],
    ['liquid-soap', /hand wash|handwash|body wash|shower gel/],
    ['detergent', /detergent|washing powder/],
  ];
  return findTaxProfile(rules.find(([, pattern]) => pattern.test(name))?.[0]) || null;
}
