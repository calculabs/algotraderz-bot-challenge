// Firestore-backed self-serve roster (no login for players, no backend to run).
//
// Reads use Firestore's public REST API — only the projectId is needed, and the
// config keys below are public-safe by design (security is enforced by Firestore
// rules, not by hiding the key). Writes happen in the browser via anonymous auth
// (see index.html) so each person can only edit their own entry.

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAc3LbLHpImAasvWPzQ2p6k3yYmijHHiSE",
  authDomain: "algobotchallenge.firebaseapp.com",
  projectId: "algobotchallenge",
  storageBucket: "algobotchallenge.firebasestorage.app",
  messagingSenderId: "778113355105",
  appId: "1:778113355105:web:aa1e70a27a80729e518920"
};

const REST = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;

// Read the self-serve roster ([{ name, url }]). Returns [] on any error so the
// board always degrades gracefully to participants.json.
export async function fetchFirestoreRoster() {
  try {
    const res = await fetch(`${REST}/roster?pageSize=500`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.documents || [])
      .map((d) => ({ name: d.fields?.name?.stringValue, url: d.fields?.url?.stringValue }))
      .filter((e) => e && e.name && e.url);
  } catch {
    return [];
  }
}

// Merge the committed seed roster with self-serve entries. Deduped by name
// (case-insensitive); a Firestore entry replaces a same-named seed entry, which
// is exactly how a player swapping their own link updates in place. Seed order is
// preserved; brand-new players are appended.
export function mergeRoster(base = [], extra = []) {
  const byName = new Map();
  for (const p of [...base, ...extra]) {
    const name = String(p.name ?? p.discord ?? "").trim();
    if (!name) continue;
    byName.set(name.toLowerCase(), { ...p, name });
  }
  return [...byName.values()];
}
