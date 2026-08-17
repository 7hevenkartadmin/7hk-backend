export const defaultHomepageBanners = [
  {
    title: "Nourish your home with Earth's finest",
    highlight: "Earth's finest",
    copy: 'Fresh, organic groceries delivered from local farms to your doorstep. Quality you can taste, convenience you deserve.',
    tag: 'Farm-Fresh & Organic',
    image: 'https://images.unsplash.com/photo-1542838132-92c53300491e?auto=format&fit=crop&w=1800&q=90',
    ctaLabel: 'Shop Now',
    ctaHref: '#products',
    isActive: true,
    sortOrder: 1,
  },
  {
    title: 'Daily dairy, bakery and breakfast essentials',
    highlight: 'breakfast essentials',
    copy: 'Milk, bread, eggs, butter and morning staples restocked daily and delivered before your kettle whistles.',
    tag: 'Morning Run Ready',
    image: 'https://images.unsplash.com/photo-1628088062854-d1870b4553da?auto=format&fit=crop&w=1800&q=90',
    ctaLabel: 'Browse Categories',
    ctaHref: '#mega-categories',
    isActive: true,
    sortOrder: 2,
  },
  {
    title: 'Save more on pantry staples this week',
    highlight: 'pantry staples',
    copy: 'Rice, dal, oils, snacks and household picks with smart deals for every family basket.',
    tag: 'Flat Rs 50 OFF - FRESH50',
    image: 'https://images.unsplash.com/photo-1604719312566-8912e9227c6a?auto=format&fit=crop&w=1800&q=90',
    ctaLabel: 'Shop Now',
    ctaHref: '#products',
    isActive: true,
    sortOrder: 3,
  },
];

export const defaultDeliveryZones = [
  { code: 'A', label: 'Zone A', limit: 4, charge: 20, orderCutoff: '20:00', isActive: true },
  { code: 'B', label: 'Zone B', limit: 8, charge: 35, orderCutoff: '19:00', isActive: true },
  { code: 'C', label: 'Zone C', limit: 10, charge: 50, orderCutoff: '19:00', isActive: true },
];

export const defaultOrderingSchedule = {
  timezone: 'Asia/Kolkata',
  weeklySchedule: [
    { dayOfWeek: 0, isOpen: true, opensAt: '09:00', closesAt: '20:00' },
    { dayOfWeek: 1, isOpen: true, opensAt: '09:00', closesAt: '20:00' },
    { dayOfWeek: 2, isOpen: true, opensAt: '09:00', closesAt: '20:00' },
    { dayOfWeek: 3, isOpen: true, opensAt: '09:00', closesAt: '20:00' },
    { dayOfWeek: 4, isOpen: true, opensAt: '09:00', closesAt: '20:00' },
    { dayOfWeek: 5, isOpen: true, opensAt: '09:00', closesAt: '20:00' },
    { dayOfWeek: 6, isOpen: true, opensAt: '09:00', closesAt: '20:00' },
  ],
  specialDates: [],
  temporaryClosure: { isActive: false, startsAt: null, endsAt: null, reason: '' },
};

export const defaultCodSettings = {
  isEnabled: true,
  maxOrderValue: 1500,
  maxPendingOrdersPerCustomer: 2,
  maxCancelledOrdersInWindow: 2,
  cancellationWindowDays: 30,
  terms: 'Cash is collected at delivery. Please keep exact change ready. Repeated COD cancellations may disable COD for your account.',
};
