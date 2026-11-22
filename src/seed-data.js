// Default salon content (Indian salon). Everything here can be changed later from the admin console.

export const DEFAULT_SETTINGS = {
  salon_name: 'Saundarya Salon & Spa',
  tagline: 'Hair. Skin. Glow.',
  quote: 'Walk in as you are, walk out feeling your most beautiful.',
  address: '12, Sunrise Complex, CG Road, Navrangpura, Ahmedabad, Gujarat 380009',
  phone: '+91 95719 30793',
  whatsapp: '+91 95719 30793',
  instagram: '',
  map_url: '',
  email: 'hello@saundarya.example',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  slot_interval: 25,
  cancel_cutoff_hours: 2,
  max_days_ahead: 60,
  // 0 = Sunday … 6 = Saturday. null = closed.
  hours: {
    0: { open: '09:00', close: '21:00' },
    1: { open: '10:00', close: '20:30' },
    2: null,
    3: { open: '10:00', close: '20:30' },
    4: { open: '10:00', close: '20:30' },
    5: { open: '10:00', close: '20:30' },
    6: { open: '09:00', close: '21:00' },
  },
  closed_dates: [],
};

// [name, category, description, duration (min), price (₹)]
export const SERVICES = [
  ['Haircut & Styling (Women)', 'Hair', 'Consultation, hair wash, precision cut and blow-dry.', 45, 700],
  ['Men’s Haircut', 'Hair', 'Classic or trendy cut with wash and styling.', 30, 300],
  ['Beard Trim & Shape', 'Hair', 'Clean beard shaping with hot towel finish.', 20, 150],
  ['Hair Spa', 'Hair', 'Deep-conditioning spa with steam and massage for soft, shiny hair.', 60, 1200],
  ['Head Massage (Champi)', 'Hair', 'Relaxing oil champi with warm coconut or almond oil.', 30, 400],
  ['Global Hair Colour', 'Colour', 'Root-to-tip ammonia-free colour.', 120, 2500],
  ['Highlights', 'Colour', 'Streaks or balayage highlights for dimension.', 150, 3500],
  ['Root Touch-up', 'Colour', 'Grey coverage at the roots.', 60, 1200],
  ['Keratin Treatment', 'Treatment', 'Frizz-free, smooth hair for up to 4 months.', 180, 6000],
  ['Hair Smoothening', 'Treatment', 'Straighter, manageable hair with lasting shine.', 180, 5000],
  ['Fruit Facial', 'Skin', 'Refreshing cleanse, scrub, massage and pack.', 60, 1200],
  ['Gold Facial', 'Skin', 'Radiance facial for festive and party glow.', 75, 2200],
  ['D-Tan Cleanup', 'Skin', 'Removes tan and brightens dull skin.', 45, 800],
  ['Eyebrow Threading', 'Threading & Wax', 'Neat, defined brows.', 15, 60],
  ['Upper Lip Threading', 'Threading & Wax', 'Quick and gentle.', 10, 40],
  ['Full Arms Waxing', 'Threading & Wax', 'Rica / chocolate wax.', 30, 500],
  ['Full Legs Waxing', 'Threading & Wax', 'Rica / chocolate wax.', 45, 800],
  ['Manicure', 'Nails', 'Soak, shape, cuticle care, massage and polish.', 45, 600],
  ['Pedicure', 'Nails', 'Foot soak, scrub, massage and polish.', 60, 800],
  ['Bridal Makeup (HD)', 'Bridal', 'HD makeup, hairstyle and draping for your big day.', 180, 15000],
  ['Party / Engagement Makeup', 'Bridal', 'Makeup and hairstyle for sangeet, engagement or parties.', 90, 4000],
  ['Saree Draping', 'Bridal', 'Perfect pleats in any style — Nivi, Gujarati, Bengali and more.', 30, 500],
];

// [name, title, bio, specialties (comma separated categories)]
export const STYLISTS = [
  ['Priya Sharma', 'Senior Hair Stylist', '10 years of cuts, colour and keratin expertise.', 'Hair,Colour,Treatment'],
  ['Rahul Verma', 'Men’s Grooming Expert', 'Sharp fades, beard styling and relaxing champi.', 'Hair'],
  ['Anjali Nair', 'Skin & Beauty Expert', 'Facials, threading and nail care with a gentle touch.', 'Skin,Threading & Wax,Nails'],
  ['Meera Kapoor', 'Bridal Makeup Artist', 'Bridal and party looks, hairstyling and saree draping for every celebration.', 'Bridal,Skin,Threading & Wax'],
];
