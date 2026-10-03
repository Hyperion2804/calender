// ============================================================
//  Hyperion Calendar config. It uses the SAME Firebase project as
//  Meeting Ledger on purpose, so it can show meetings, scheduled
//  meetings and travel plans, and so the same accounts sign in.
//  Copy these values from Meeting Ledger's config.js; don't change them.
// ============================================================

// 1. Your organisation's email domain. Only these addresses can sign in.
export const ORG_DOMAIN = "hyperioncapital.in";

// 2. Your Firebase project's config (from Firebase Console -> Project settings).
export const firebaseConfig = {
  apiKey: "AIzaSyDyl73p3CgKDOiTnLfxuYwE_oIHyyJmiyQ",
  authDomain: "meeting-ledger.firebaseapp.com",
  projectId: "meeting-ledger",
  storageBucket: "meeting-ledger.firebasestorage.app",
  messagingSenderId: "520159635970",
  appId: "1:520159635970:web:54ade9e2e65671f461151b"
};

// 3. Office timings — one schedule for the whole firm (RMs, Team Leads,
//    Admins, Superadmins). Holidays are added in Hyperion Calendar → Holidays.
//    If this ever changes, change it in BOTH apps' config.js.
export const OFFICE = {
  start: "09:30",            // 24-hour HH:MM
  end:   "18:30",
  offSaturdays: [2, 4]       // 2nd and 4th Saturday of each month are off; Sundays always off
};
