/* Site content — the built-in copy of every CMS section, plus the validation rules the API applies.
   /api/cms/:section answers with these until the admin saves an override. skms-frontend keeps its own copy of
   DEFAULTS (src/lib/content.js) so pages render while this service is waking up — edit both together. */

const DEFAULTS = {
  hero: {
    headline: 'Master Clinical\n*Excellence*\nfor Gulf Licensing',   // one row per line, *word* = green italic
    sub: 'AI-powered clinical learning designed specifically for Gulf licensing examinations. Join 500+ doctors who passed HAAD, DHA, SLE, QCHP and more on their first attempt.',
    cta1Text: 'Explore Courses', cta1Link: 'courses.html',
    cta2Text: 'View Plans', cta2Link: 'plans.html',
    image: 'img/hero.jpg',
  },

  /* "Face Real Cases" banner under the hero. *word* = green italic, **words** = bold */
  cases: {
    eyebrow: 'Highly Recommended',
    headline: 'Face Real Cases.\n*Sharpen Your Clinical Thinking.*',
    body: [
      'Introducing an **AI-integrated Realistic Clinical Scenario Learning Platform** — built to bridge the gap between classroom knowledge and real clinical practice.',
      'Master the most common, must-know clinical cases faster than ever through realistic AI-powered patient–doctor video learning.',
    ],
    pills: ['Final Year Medical Students', 'Gulf Licensing Candidates', 'Competitive Clinical Examinations Worldwide'],
    quote: 'Our innovative AI-powered learning platform bridges the gap between classroom knowledge and real clinical practice.',
  },

  /* Plans live in the app database (`plans` table): title, price, days, access label and features come from there.
     These cards are the website's presentation — which plan (planId) a card sells, tone, flag, note, "was" price —
     plus a fallback copy of the database values for when it can't be reached.
     program: id (plans.html#id), label, courseId (app `courses` row), and home-card promo wording (all optional):
     badge, flag, early (note in the price box), tone — never a price.
     card: planId, name (shown only on named cards), price (INR), durationDays, duration (access label), features[],
     was, note, flag, sub, tone (grey|blue|pink), dark */
  plans: [
    { id: 'gp', label: 'GP License Exam', courseId: 22, cards: [
      { planId: 14, name: 'Plan A', price: 60, durationDays: 30, duration: '30 days access', tone: 'grey', features: ['Mock Test', 'Rapid Recalls'] },
      { planId: 15, name: 'Plan B', price: 85, durationDays: 45, duration: '45 days access', tone: 'blue', features: ['MCQ Bank', 'Mock Test', 'Rapid Recalls'] },
      { planId: 16, name: 'Plan C', price: 150, durationDays: 45, duration: '45 days access', tone: 'pink', features: ['MCQ Bank', 'Mock Test', 'Rapid Recalls', 'Video Lectures'] },
    ] },
    { id: 'specialist', label: 'Specialist License Exam', courseId: 19, tone: 'blue', cards: [
      { planId: 23, name: 'Plan A', price: 100, durationDays: 45, duration: '45 days access', tone: 'grey', features: ['MCQ Bank', 'Mock Test'] },
      { planId: 24, name: 'Plan B', price: 200, durationDays: 45, duration: '45 days access', tone: 'blue', features: ['MCQ Bank', 'Mock Test', 'Video Lectures'] },
    ] },
    { id: 'ai', label: 'AI Live Patient', courseId: 20, badge: 'Subscription', flag: '★ Early Bird Available', early: 'Early Bird 30% off', cards: [
      { planId: 25, price: 119, durationDays: 90, duration: '3 months', tone: 'grey',
        note: 'Full AI Live Patient access for 3 months — unlimited clinical scenarios, patient–doctor video learning, and interactive case sessions.' },
      { planId: 26, price: 104.3, was: 149, durationDays: 180, duration: '6 months', dark: true, flag: '★ Early Bird 30% off', sub: 'Save 30% — limited time',
        note: 'Full AI Live Patient access for 6 months — unlimited clinical scenarios, patient–doctor video learning, and interactive case sessions.' },
      { planId: 27, price: 200, durationDays: 365, duration: '12 months', tone: 'blue',
        note: 'Full AI Live Patient access for 12 months — unlimited clinical scenarios, patient–doctor video learning, and interactive case sessions.' },
    ] },
    { id: 'final', label: 'Final Year Medicine Practical', courseId: 21, cards: [
      { planId: 28, name: 'Final year practical', price: 50, durationDays: 45, duration: '45 days full access', tone: 'blue', features: ['Course completion', 'Practical examination techniques'] },
    ] },
  ],

  testimonials: [
    { name: 'Dr. Risi Baderi', role: 'General practitioner - India', rating: 5, body: 'This academy completely transformed my approach to the Kuwait GP licensing examination. The structured study plan, high-yield clinical cases, and AI-powered patient–doctor video scenarios made complex topics much easier to understand. Thank you to the entire team for their outstanding guidance and support.' },
    { name: 'Dr. Nourhan Hussien', role: 'General practitioner - Egypt', rating: 5, body: 'I would like to sincerely thank my amazing doctor and course instructor for all her hard work, dedication, and continuous support throughout my preparation for the Kuwait Prometric Exam. The Prometric questions, revision sessions, practical cases, and exam-oriented guidance were extremely valuable and made a huge difference in my preparation, confidence and every effort she put into helping us succeed. I highly recommend her course to anyone preparing for the Kuwait Prometric Exam.' },
    { name: 'Dr. Rania Ibrahim', role: 'General practitioner - India', rating: 5, body: 'I am happy to share that I have successfully passed the Kuwait prometric Exam. Thank you for the support. The exam was well-structured and focused on practical clinical knowledge and patient management. Consistent study, regular MCQ practice and your guidance were key to my success. I would encourage future candidates to attend the class, practice case-based questions, and manage their time effectively during the exam. Wishing all future candidates the very best.' },
    { name: 'Dr Shanas', role: 'General practitioner - India', rating: 5, body: 'Thank you so much for the incredible support during my Kuwait exam preparation. Your high-yield tips, revision and encouragement gave me the confidence I needed to clear the exam successfully.' },
  ],

  /* "What Our Students Say" — managed in admin → Student Reviews. Never empty: an emptied list falls back
     to these, so the home section always has cards (cmsGet and the server's readReviews both do that). */
  reviews: [
    { name: 'Dr. Fatima Al-Zahra', role: 'DHA Candidate, UAE', rating: 5, body: 'The AI Live Patient cases and clinical reasoning breakdown gave me the exact confidence needed to clear my Dubai Health Authority exam on the first attempt. Outstanding resource!' },
    { name: 'Dr. Arun Varma', role: 'General Practitioner, Oman', rating: 5, body: 'Realistic clinical scenarios that simulate genuine Gulf licensing standards. Highly effective for bridging textbook medicine with high-yield exam stations.' },
    { name: 'Dr. Sarah Jenkins', role: 'Final Year Resident, Bahrain', rating: 5, body: 'Comprehensive practical exam simulations with crystal-clear explanations. It made preparing for viva and clinical stations straightforward and stress-free.' },
    { name: 'Dr. Hrithik Suresh', role: 'Consultant Neurosurgeon, UAE & Saudi Arabia', rating: 5, body: 'The specialized clinical judgment modules and real-time patient case analyses were exceptionally accurate for high-stakes surgical licensing viva. The depth of clinical scenarios provided the exact precision and diagnostic clarity required to clear my specialist board evaluation with ease.' },
    { name: 'Dr. Ananya Nair', role: 'MOH Candidate, Kuwait', rating: 5, body: 'The structured study plan and rapid recalls fit around my hospital shifts, and the mock tests mirrored the real Prometric paper. Every doubt I sent the faculty came back answered the same day.' },
  ],

  faculty: [
    { name: 'Dr. Aravind', role: 'Kuwait Licensed ENT Surgeon', photo: 'img/fac-aravind.jpg' },
    { name: 'Dr. Shahana Kuruniyan', role: 'Dermatology', photo: 'img/fac-shahana.jpg' },
    { name: 'Dr. Saadia', role: 'Gen. Physician-Prometric Exam Tutor', photo: 'img/fac-saadia.jpg' },
    { name: 'Dr. Sofia John', role: 'OMSB Licensed Gen. Surgeon', photo: 'img/fac-sofia.jpg' },
    { name: 'Dr. Suhail Ahamed', role: 'Doctor of AI Media Production', photo: 'img/fac-suhail.jpg' },
    { name: 'Dr. Nandita', role: 'Specialist pediatrician', photo: 'img/fac-nandita.jpg' },
  ],

  /* thin bar above the site header; admin → Announcement. Hidden while `enabled` is false or `text` is empty */
  announcement: { enabled: false, text: '', linkText: '', link: '' },

  faqs: [
    { q: 'Which Gulf licensing examinations does the Academy cover?', a: 'We cover all major Gulf licensing examinations including HAAD, DHA, and MOH (UAE), SLE (Saudi Arabia). QCHP (Qatar), NHRA (Bahrain), MOH Kuwait, and OMSB (Oman). Content is updated each examination cycle' },
    { q: 'How does the AI clinical learning system work?', a: 'Our AI recreates realistic patient–doctor encounters as video scenarios. You observe history taking, examination technique and reasoning, then work through case-based MCQs built on the same case.' },
    { q: 'Are the courses taught by qualified faculty?', a: 'Yes. Every course is delivered by licensed specialists and surgeons practising in the GCC, supported by our AI media production team.' },
    { q: 'Is there a refund policy?', a: 'Plans are refundable within 48 hours of purchase provided less than 10% of the course content has been accessed. Write to drakmsacademy@gmail.com to start a request.' },
    { q: 'Can I access the content on mobile?', a: "Yes — the SKM's Academy app is available on the Apple Store and Play Store, and your plan syncs across web and mobile." },
    { q: 'How long does a plan stay active?', a: 'Access length is shown on each plan card — from 30 days up to 12 months for AI Live Patient subscriptions.' },
  ],
};

/* withAppPlans(groups, rows): the plans the website sells. `groups` is the presentation (CMS or DEFAULTS); `rows` are
   the app database's plan rows (server.js reads them). A card shows its row's title, price, days, access label and
   features — so the card, the checkout charge and the app subscription can never disagree. A card whose row is
   switched off (isActive=false) or gone is dropped. `rows` null = database unreachable: cards keep their saved copy. */
const ENTITLEMENT_LABELS = { mcq: 'MCQ Bank', mock: 'Mock Test', rapid_recall: 'Rapid Recalls', video_lecture: 'Video Lectures' };
function withAppPlans(groups, rows) {
  const byId = rows && new Map(rows.filter(r => r.isActive).map(r => [r.id, r]));
  return groups.map(g => {
    const d = DEFAULTS.plans.find(x => x.id === g.id);
    // a legacy CMS copy (saved before cards had planIds: stale prices, the retired Plan D) never sells — the built-in cards stand in
    const cards = g.cards?.some(c => c.planId) || !d ? g.cards || [] : d.cards;
    const courseId = g.courseId ?? d?.courseId;
    if (!byId) return { ...g, courseId, cards };
    return { ...g, courseId, cards: cards.filter(c => byId.has(c.planId)).map(c => {
      const r = byId.get(c.planId);
      return { ...c, name: c.name ? r.title : undefined, price: Number(r.price), durationDays: r.durationDays,
        duration: r.durationLabel || `${r.durationDays} days access`,
        // the app stores feature text only sometimes; its access keys (entitlements) read as labels — never written back
        features: r.features?.length ? r.features : r.entitlements?.length ? r.entitlements.map(e => ENTITLEMENT_LABELS[e] || e) : c.features };
    }) };
  });
}

const planLabel = (group, card) => [group.label, card.name || card.duration].filter(Boolean).join(' — ');

/* buyer details on a checkout order */
function cleanBuyer({ name, email, phone } = {}) {
  name = String(name ?? '').trim();
  email = String(email ?? '').trim().toLowerCase();
  phone = String(phone ?? '').replace(/[\s()-]/g, '');
  const ok = name && name.length <= 100 && email.length <= 200
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    // phone is optional: one-click checkout sends whatever the account has, and Razorpay's own
    // overlay asks for a contact number when we pass none. A phone that IS given must still be valid.
    && (phone === '' || /^\+?\d{7,15}$/.test(phone));
  return ok ? { name, email, phone } : null;
}

/* one published student review */
function cleanReview({ name, role, rating, body } = {}) {
  name = String(name ?? '').trim(); role = String(role ?? '').trim(); body = String(body ?? '').trim();
  rating = Number(rating);
  const ok = name && name.length <= 100 && role.length <= 100 && body && body.length <= 2000
    && Number.isInteger(rating) && rating >= 1 && rating <= 5;
  return ok ? { name, role, rating, body } : null;
}

module.exports = { DEFAULTS, planLabel, cleanBuyer, cleanReview, withAppPlans };
