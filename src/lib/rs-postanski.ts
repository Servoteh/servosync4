// Poštanski brojevi Srbije — mapa najčešćih mesta (PTT broj, 5 cifara).
// Port 1.0 `src/lib/rsPostanskiBrojevi.js`. Auto-popuna Grad ↔ Poštanski broj
// u kartonu zaposlenog; poređenje case-insensitive i bez dijakritika.

/** Kanonsko ime mesta → poštanski broj. */
const MESTA: Record<string, string> = {
  /* ── Beograd i okolina ── */
  'Beograd': '11000',
  'Novi Beograd': '11070',
  'Zemun': '11080',
  'Borča': '11211',
  'Železnik': '11250',
  'Sremčica': '11253',
  'Umka': '11260',
  'Surčin': '11271',
  'Dobanovci': '11272',
  'Batajnica': '11273',
  'Boljevci': '11275',
  'Ugrinovci': '11276',
  'Jakovo': '11277',
  'Bečmen': '11279',
  'Grocka': '11306',
  'Mladenovac': '11400',
  'Sopot': '11450',
  'Barajevo': '11460',
  'Obrenovac': '11500',
  'Barič': '11504',
  'Zvečka': '11507',
  'Lazarevac': '11550',
  /* ── Podunavlje / Smederevo ── */
  'Smederevo': '11300',
  'Velika Plana': '11320',
  'Smederevska Palanka': '11420',
  /* ── Braničevo ── */
  'Požarevac': '12000',
  'Veliko Gradište': '12220',
  'Kučevo': '12240',
  'Petrovac na Mlavi': '12300',
  /* ── Kolubara ── */
  'Valjevo': '14000',
  'Ub': '14210',
  'Lajkovac': '14224',
  'Ljig': '14240',
  'Mionica': '14242',
  /* ── Mačva ── */
  'Šabac': '15000',
  'Loznica': '15300',
  'Krupanj': '15314',
  'Ljubovija': '15320',
  'Bogatić': '15350',
  /* ── Jablanica / Pčinja ── */
  'Leskovac': '16000',
  'Vlasotince': '16210',
  'Lebane': '16230',
  'Vranje': '17500',
  'Vladičin Han': '17510',
  'Bujanovac': '17520',
  'Surdulica': '17530',
  /* ── Niš i jug ── */
  'Niš': '18000',
  'Aleksinac': '18220',
  'Sokobanja': '18230',
  'Pirot': '18300',
  'Bela Palanka': '18310',
  'Dimitrovgrad': '18320',
  'Prokuplje': '18400',
  'Kuršumlija': '18430',
  /* ── Timočka krajina ── */
  'Zaječar': '19000',
  'Bor': '19210',
  'Majdanpek': '19250',
  'Negotin': '19300',
  'Kladovo': '19320',
  'Knjaževac': '19350',
  /* ── Južna Bačka ── */
  'Novi Sad': '21000',
  'Petrovaradin': '21131',
  'Sremski Karlovci': '21205',
  'Bečej': '21220',
  'Žabalj': '21230',
  'Temerin': '21235',
  'Bačka Palanka': '21400',
  'Futog': '21410',
  'Vrbas': '21460',
  'Srbobran': '21480',
  /* ── Srem ── */
  'Sremska Mitrovica': '22000',
  'Šid': '22240',
  'Stara Pazova': '22300',
  'Novi Banovci': '22304',
  'Šimanovci': '22310',
  'Inđija': '22320',
  'Nova Pazova': '22330',
  'Ruma': '22400',
  'Pećinci': '22410',
  /* ── Banat ── */
  'Zrenjanin': '23000',
  'Novi Bečej': '23272',
  'Kikinda': '23300',
  'Pančevo': '26000',
  'Opovo': '26204',
  'Kovačica': '26210',
  'Kovin': '26220',
  'Vršac': '26300',
  'Alibunar': '26310',
  'Bela Crkva': '26340',
  /* ── Severna Bačka / Sombor ── */
  'Subotica': '24000',
  'Bačka Topola': '24300',
  'Senta': '24400',
  'Kanjiža': '24420',
  'Ada': '24430',
  'Sombor': '25000',
  'Kula': '25230',
  'Odžaci': '25250',
  'Apatin': '25260',
  /* ── Zlatibor / Moravica ── */
  'Užice': '31000',
  'Požega': '31210',
  'Arilje': '31230',
  'Bajina Bašta': '31250',
  'Kosjerić': '31260',
  'Prijepolje': '31300',
  'Čajetina': '31310',
  'Zlatibor': '31315',
  'Nova Varoš': '31320',
  'Priboj': '31330',
  'Čačak': '32000',
  'Guča': '32230',
  'Ivanjica': '32250',
  'Gornji Milanovac': '32300',
  /* ── Šumadija / Pomoravlje ── */
  'Kragujevac': '34000',
  'Aranđelovac': '34300',
  'Topola': '34310',
  'Jagodina': '35000',
  'Svilajnac': '35210',
  'Despotovac': '35213',
  'Ćuprija': '35230',
  'Paraćin': '35250',
  /* ── Raška / Rasina ── */
  'Kraljevo': '36000',
  'Vrnjačka Banja': '36210',
  'Novi Pazar': '36300',
  'Tutin': '36320',
  'Raška': '36350',
  'Kruševac': '37000',
  'Brus': '37220',
  'Aleksandrovac': '37230',
  'Trstenik': '37240',
};

/** Normalizacija za poređenje: lowercase, đ→dj, bez dijakritika, jedan razmak. */
function normalize(s: string | null | undefined): string {
  return String(s || '')
    .toLowerCase()
    .replace(/đ/g, 'dj')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const BY_NAME = new Map<string, string>();
const BY_CODE = new Map<string, string>();
for (const [name, code] of Object.entries(MESTA)) {
  BY_NAME.set(normalize(name), code);
  if (!BY_CODE.has(code)) BY_CODE.set(code, name);
}

/** Poštanski broj za dato mesto (case/dijakritik-insensitive) ili null. */
export function postanskiZaGrad(grad: string | null | undefined): string | null {
  const key = normalize(grad);
  if (!key) return null;
  return BY_NAME.get(key) || null;
}

/** Kanonsko ime mesta za dati poštanski broj (5 cifara) ili null. */
export function gradZaPostanski(broj: string | number | null | undefined): string | null {
  const key = String(broj || '').trim();
  if (!/^\d{5}$/.test(key)) return null;
  return BY_CODE.get(key) || null;
}
