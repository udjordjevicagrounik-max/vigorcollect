/**
 * Demo invoice file for the import wizard (task 2.2, rule 24: generated data only). Deterministic
 * (fixed seed) and relative to TODAY, so every aging bucket and "due today" has rows whenever it
 * is generated. Companies only, tax ids in the reserved DEMO- space, Serbian export conventions
 * (";" separator, decimal comma, dd.mm.yyyy).
 *
 *   npx tsx scripts/demo-import/generate.ts > scripts/demo-import/fakture-demo.csv
 */

export const DEMO_CUSTOMERS = [
  { taxId: 'DEMO-200000001', name: 'Demo Agro d.o.o.' },
  { taxId: 'DEMO-200000002', name: 'Test Trgovina d.o.o.' },
  { taxId: 'DEMO-200000003', name: 'Primer Gradnja a.d.' },
  { taxId: 'DEMO-200000004', name: 'Ogled Logistika d.o.o.' },
  { taxId: 'DEMO-200000005', name: 'Uzorak Farm d.o.o.' },
  { taxId: 'DEMO-200000006', name: 'Proba Energetika d.o.o.' },
  { taxId: 'DEMO-200000007', name: 'Model Prehrana a.d.' },
  { taxId: 'DEMO-200000008', name: 'Šablon Transport d.o.o.' },
] as const;

// Days past due per invoice (negative = not due yet): covers 0, 1–30, 31–60, 61–90, 91–180, 180+.
const PAST_DUE = [
  -25, -20, -12, -7, -5, -2, 0, 0, 1, 3, 5, 8, 12, 15, 19, 25, 29, 33, 38, 45, 47, 52, 58, 61, 64,
  70, 75, 83, 88, 95, 104, 120, 135, 150, 175, 190, 220, 240, 310, 400,
];

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dmy(date: Date): string {
  const d = String(date.getUTCDate()).padStart(2, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${d}.${m}.${date.getUTCFullYear()}`;
}

/** Whole-cent amount as "1.234.567,89" built from integers — no float in the value. */
function amountText(cents: bigint): string {
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${whole},${(cents % 100n).toString().padStart(2, '0')}`;
}

export function demoCsv(today: Date = new Date(), currency = 'RSD'): string {
  const rng = mulberry32(20261012);
  const base = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const day = 86_400_000;
  const lines = [
    'ID;Broj fakture;Datum fakture;Datum dospeća;Oznaka valute;Iznos;Saldo;PIB;Naziv kupca',
  ];
  PAST_DUE.forEach((pastDue, i) => {
    const customer = DEMO_CUSTOMERS[i % DEMO_CUSTOMERS.length] ?? DEMO_CUSTOMERS[0];
    const due = new Date(base - pastDue * day);
    const issue = new Date(due.getTime() - 30 * day);
    const total =
      BigInt(Math.floor(rng() * 900_000) + 10_000) * 100n + BigInt(Math.floor(rng() * 100));
    // Every fourth invoice is partly paid in the ERP: open = 40 % of the total (integer cents).
    const open = i % 4 === 3 ? (total * 40n) / 100n : total;
    lines.push(
      [
        `ERP-${String(1000 + i)}`,
        `F-${due.getUTCFullYear()}-${String(400 + i).padStart(4, '0')}`,
        dmy(issue),
        dmy(due),
        currency,
        amountText(total),
        amountText(open),
        customer.taxId,
        customer.name,
      ].join(';'),
    );
  });
  return `${lines.join('\r\n')}\r\n`;
}

if (process.argv[1]?.endsWith('generate.ts')) process.stdout.write(demoCsv());
