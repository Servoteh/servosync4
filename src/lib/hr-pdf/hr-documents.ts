import { openDocument, safeName } from './pdf-core';
import { toCyrillic as cyr } from './cyrillic';

// HR dokumenti (ćirilica, Roboto/UTF-8, logo). Port 1.0 `src/lib/hrDocPdf.js` +
// `vacationDecisionPdf.js`. Dinamička polja se preslovljavaju u ćirilicu OVDE
// (ulaz je latinica iz baze) — izuzetak: Sporazumni raskid (latiničan šablon).
// Pravni tekstovi su VERBATIM iz 1.0 (paritet formata dokumenata).

export interface PdfResult {
  blob: Blob;
  fileName: string;
}

/* ── Rešenje o godišnjem odmoru ──────────────────────────────────────────── */

export interface VacationDecisionInput {
  brojResenja?: string;
  datumDonosenja?: string; // formatiran "25.06.2026."
  mesto?: string;
  godina: number | string;
  imePrezime: string;
  jmbg?: string;
  radnoMesto: string;
  brojDana: number;
  datumOd: string;
  datumDo: string;
  datumPovratka?: string;
  saldo?: { ukupno: number; iskorisceno: number; preostalo: number } | null;
  potpisPoslodavac?: string;
}

export async function generateVacationDecisionPdf(d: VacationDecisionInput): Promise<PdfResult> {
  const ctx = await openDocument({ broj: d.brojResenja, datum: d.datumDonosenja, mesto: cyr(d.mesto) || 'Добановци' });
  const { para, signatures, finalize } = ctx;
  const ime = cyr(d.imePrezime);

  para(
    'На основу члана 192, а у вези са члановима 68–76. Закона о раду (Сл. гласник РС бр. 24/05, '
    + '61/05, 54/09, 32/2013, 75/2014, 13/2017, 113/2017 и 95/2018 — аутентично тумачење), '
    + `овлашћено лице послодавца „СЕРВОТЕХ" д.о.о. Добановци, дана ${d.datumDonosenja || '________'} године, доноси`,
    { gap: 3 },
  );
  para('Р Е Ш Е Њ Е', { bold: true, align: 'center', size: 15, gap: 1.2 });
  para(`о годишњем одмору за ${d.godina}. годину`, { bold: true, align: 'center', size: 11.5, gap: 4 });

  para(
    `Запосленом ${ime}, ЈМБГ ${d.jmbg || '________________'}, на радном месту ${cyr(d.radnoMesto)}, `
    + `одређује се годишњи одмор за ${d.godina}. годину у укупном трајању од ${d.brojDana} радних дана.`,
  );
  para(
    `Годишњи одмор ће се користити непрекидно, почев од ${d.datumOd} године закључно са ${d.datumDo} године, `
    + `с тим да се запослени на посао треба да јави дана ${d.datumPovratka || '________'} године.`,
  );
  para('У број дана годишњег одмора не рачунају се суботе, недеље и државни празници.');
  if (d.saldo) {
    para(
      `Стање годишњег одмора за ${d.godina}. годину: укупно ${d.saldo.ukupno} · искоришћено `
      + `${d.saldo.iskorisceno} · преостало ${d.saldo.preostalo} радних дана.`,
      { size: 10, color: [90, 90, 90] },
    );
  }
  para('Запослени се не може одрећи права на годишњи одмор, нити му се то право може ускратити.', { gap: 3 });

  para('О Б Р А З Л О Ж Е Њ Е', { bold: true, align: 'center', gap: 1.6 });
  para(
    'У складу са потребама посла, а уз претходну консултацију запосленог, донето је решење као у '
    + 'диспозитиву. Запослени је поднео захтев за коришћење годишњег одмора путем интерне апликације, '
    + 'који је одобрен од стране надлежног руководиоца и службе за кадровске послове.',
  );
  para(
    'Поука о правном леку: Против овог решења запослени може покренути спор пред надлежним судом '
    + 'у року од 60 дана од дана достављања овог решења.',
    { gap: 10 },
  );

  signatures('Решење примио/-ла,', ime, 'Овлашћено лице послодавца,', cyr(d.potpisPoslodavac) || 'Ненад Јараковић', {
    rightMP: true,
    leftDate: true,
  });

  return { blob: finalize(`Решење о годишњем одмору — ${ime}`), fileName: `Resenje_GO_${d.godina}_${safeName(d.imePrezime)}.pdf` };
}

/* ── Potvrda o zaposlenju ────────────────────────────────────────────────── */

export interface EmploymentCertInput {
  imePrezime: string;
  jmbg?: string;
  radnoMesto: string;
  datumZaposlenja?: string;
  tipUgovora?: string; // npr. "na neodređeno vreme"
  broj?: string;
  datum?: string;
  mesto?: string;
  potpisPoslodavac?: string;
}

export async function generateEmploymentCertificatePdf(d: EmploymentCertInput): Promise<PdfResult> {
  const ctx = await openDocument({ broj: d.broj, datum: d.datum, mesto: cyr(d.mesto) || 'Добановци' });
  const { para, signatures, finalize } = ctx;
  const ime = cyr(d.imePrezime);

  para('ПОТВРДА О ЗАПОСЛЕЊУ', { bold: true, align: 'center', size: 14, gap: 5 });
  para(
    `Потврђује се да је ${ime}, ЈМБГ ${d.jmbg || '________________'}, запослен/-а у `
    + 'привредном друштву „СЕРВОТЕХ" д.о.о. Добановци, ул. Угриновачка 163, на радном месту '
    + `${cyr(d.radnoMesto)}, са пуним радним временом${d.datumZaposlenja ? `, почев од ${d.datumZaposlenja} године` : ''}`
    + `${d.tipUgovora ? `, по уговору о раду ${cyr(d.tipUgovora)}` : ''}.`,
    { gap: 3 },
  );
  para(
    'Потврда се издаје на лични захтев запосленог/-е ради остваривања права и не може се '
    + 'користити у друге сврхе.',
    { gap: 12 },
  );
  signatures('', '', 'За послодавца,', cyr(d.potpisPoslodavac) || 'Ненад Јараковић', { rightMP: true });

  return { blob: finalize(`Потврда о запослењу — ${ime}`), fileName: `Potvrda_zaposlenje_${safeName(d.imePrezime)}.pdf` };
}

/* ── Potvrda o visini primanja ───────────────────────────────────────────── */

export interface SalaryCertInput {
  imePrezime: string;
  jmbg?: string;
  radnoMesto: string;
  brutoZarada: string; // formatiran iznos
  broj?: string;
  datum?: string;
  mesto?: string;
  potpisPoslodavac?: string;
}

export async function generateSalaryCertificatePdf(d: SalaryCertInput): Promise<PdfResult> {
  const ctx = await openDocument({ broj: d.broj, datum: d.datum, mesto: cyr(d.mesto) || 'Добановци' });
  const { para, signatures, finalize } = ctx;
  const ime = cyr(d.imePrezime);

  para('ПОТВРДА О ВИСИНИ ПРИМАЊА', { bold: true, align: 'center', size: 14, gap: 5 });
  para(
    `Потврђује се да је ${ime}, ЈМБГ ${d.jmbg || '________________'}, запослен/-а у `
    + `привредном друштву „СЕРВОТЕХ" д.о.о. Добановци, на радном месту ${cyr(d.radnoMesto)}, и да `
    + `остварује основну зараду у бруто износу од ${cyr(d.brutoZarada)}, у складу са уговором о раду.`,
    { gap: 3 },
  );
  para(
    'Потврда се издаје на лични захтев запосленог/-е ради остваривања права (банка, '
    + 'надлежни органи и сл.) и не може се користити у друге сврхе.',
    { gap: 12 },
  );
  signatures('', '', 'За послодавца,', cyr(d.potpisPoslodavac) || 'Ненад Јараковић', { rightMP: true });

  return { blob: finalize(`Потврда о висини примања — ${ime}`), fileName: `Potvrda_primanja_${safeName(d.imePrezime)}.pdf` };
}

/* ── Aneks ugovora (radno mesto + opis poslova) ──────────────────────────── */

export interface AnnexInput {
  imePrezime: string;
  jmbg?: string;
  radnoMesto: string;
  reportsToLine?: string;
  opisStavke?: string[];
  ugovorBroj?: string;
  ugovorDatum?: string;
  aneksBroj?: string;
  broj?: string;
  datum?: string;
  mesto?: string;
  potpisPoslodavac?: string;
}

export async function generateAnnexPdf(d: AnnexInput): Promise<PdfResult> {
  const ctx = await openDocument({ broj: d.broj, datum: d.datum, mesto: cyr(d.mesto) || 'Добановци' });
  const { para, bullet, signatures, finalize, advance } = ctx;
  const ime = cyr(d.imePrezime);

  para(
    'На основу члана 171. став 1. тачка 1) и члана 172. Закона о раду (Сл. гласник РС бр. 24/05, '
    + '61/05, 54/09, 32/2013, 75/2014, 13/2017, 113/2017 и 95/2018 — аутентично тумачење) и '
    + 'Правилника о организацији и систематизацији радних места, овлашћено лице послодавца '
    + `„СЕРВОТЕХ" д.о.о. Добановци, дана ${d.datum || '________'} године, доноси`,
    { gap: 3 },
  );
  para(`АНЕКС${d.aneksBroj ? ` БР. ${d.aneksBroj}` : ''} УГОВОРА О РАДУ`, { bold: true, align: 'center', size: 14, gap: 1.2 });
  para(
    d.ugovorBroj || d.ugovorDatum
      ? `(уз Уговор о раду${d.ugovorBroj ? ` бр. ${d.ugovorBroj}` : ''}${d.ugovorDatum ? ` од ${d.ugovorDatum} године` : ''})`
      : '(уз постојећи Уговор о раду)',
    { align: 'center', size: 10, gap: 4, color: [90, 90, 90] },
  );
  para(
    `закључен између послодавца „СЕРВОТЕХ" д.о.о. Добановци и запосленог/-е ${ime}, `
    + `ЈМБГ ${d.jmbg || '________________'} (у даљем тексту: Запослени).`,
    { gap: 3 },
  );

  para('Члан 1.', { bold: true, align: 'center', gap: 1.2 });
  para(
    'Услед усвајања новог Правилника о организацији и систематизацији радних места, мења се '
    + 'одредба Уговора о раду којом је утврђено радно место и опис послова, тако да Запослени '
    + `обавља послове на радном месту: ${cyr(d.radnoMesto)}.`,
  );
  if (d.reportsToLine) para(`За свој рад Запослени одговара надређеном по хијерархији: ${cyr(d.reportsToLine)}.`);
  if (Array.isArray(d.opisStavke) && d.opisStavke.length) {
    para('Опис послова радног места (кључне одговорности):', { gap: 1.0 });
    d.opisStavke.forEach((s) => bullet(cyr(s)));
    advance(1);
  }
  para(
    'Детаљан опис послова утврђен је Правилником о организацији и систематизацији радних места '
    + 'и описом радног места, који чине саставни део овог анекса.',
    { gap: 3 },
  );

  para('Члан 2.', { bold: true, align: 'center', gap: 1.2 });
  para(
    'Остале одредбе Уговора о раду остају непромењене и важе у пуном обиму. Овај анекс чини '
    + 'саставни део Уговора о раду и ступа на снагу даном потписивања.',
  );
  para(
    'Анекс је сачињен у 3 (три) истоветна примерка, од којих 2 (два) задржава Послодавац, '
    + 'а 1 (један) Запослени.',
    { gap: 12 },
  );

  signatures('Запослени,', ime, 'За послодавца,', cyr(d.potpisPoslodavac) || 'Ненад Јараковић', { rightMP: true });

  return { blob: finalize(`Анекс уговора о раду — ${ime}`), fileName: `Aneks_ugovora_${safeName(d.imePrezime)}.pdf` };
}

/* ── Rešenje o porodiljskom odsustvu ─────────────────────────────────────── */

export interface MaternityInput {
  imePrezime: string;
  jmbg?: string;
  radnoMesto: string;
  datumPocetka: string;
  datumZavrsetka: string;
  trajanjeDana?: number;
  broj?: string;
  datum?: string;
  mesto?: string;
  potpisPoslodavac?: string;
}

export async function generateMaternityDecisionPdf(d: MaternityInput): Promise<PdfResult> {
  const ctx = await openDocument({ broj: d.broj, datum: d.datum, mesto: cyr(d.mesto) || 'Добановци' });
  const { para, signatures, finalize } = ctx;
  const ime = cyr(d.imePrezime);

  para(
    'На основу члана 94 (94а) Закона о раду (Сл. гласник РС бр. 24/05, 61/05, 54/09, 32/2013, '
    + `75/2014, 13/2017, 113/2017 и 95/2018 — аутентично тумачење), директор предузећа „СЕРВОТЕХ" `
    + `Д.О.О. ДОБАНОВЦИ, дана ${d.datum || '________'} године, доноси`,
    { gap: 3 },
  );
  para('Р Е Ш Е Њ Е', { bold: true, align: 'center', size: 15, gap: 1.2 });
  para('о породиљском одсуству и одсуству са рада ради неге детета', { bold: true, align: 'center', size: 11.5, gap: 4 });

  para(
    `${ime}, ЈМБГ ${d.jmbg || '________________'}, запослена у „Сервотех" д.о.о. на `
    + `пословима ${cyr(d.radnoMesto)}, отпочела је коришћење породиљског одсуства дана ${d.datumPocetka} године.`,
  );
  para(
    `Породиљско одсуство и одсуство са рада ради неге детета одобрава се од ${d.datumPocetka} године `
    + `до ${d.datumZavrsetka} године${d.trajanjeDana ? ` (у трајању од ${d.trajanjeDana} дана)` : ''}.`,
  );
  para(
    'За време породиљског одсуства и одсуства са рада ради неге детета запослена има право на '
    + 'накнаду зараде, у складу са законом.',
    { gap: 3 },
  );

  para('О Б Р А З Л О Ж Е Њ Е', { bold: true, align: 'center', gap: 1.6 });
  para(
    `Запослена ${ime} је према налазу надлежног здравственог органа започела коришћење `
    + `породиљског одсуства дана ${d.datumPocetka} године. У складу са Законом о раду, члан 94, `
    + 'запосленој припада право на породиљско одсуство и одсуство са рада ради неге детета '
    + `${d.trajanjeDana ? `у трајању од ${d.trajanjeDana} дана` : ''}, па је донето ово решење.`,
  );
  para(
    'Поука о правном средству: Против овог решења запослена може у року од 8 дана од дана '
    + 'достављања да покрене спор пред надлежним судом.',
    { gap: 12 },
  );

  signatures('Решење примила,', ime, 'Директор,', cyr(d.potpisPoslodavac) || 'Ненад Јараковић', {
    rightMP: true,
    leftDate: true,
  });

  return { blob: finalize(`Решење о породиљском одсуству — ${ime}`), fileName: `Resenje_porodiljsko_${safeName(d.imePrezime)}.pdf` };
}

/* ── Sporazumni raskid ugovora o radu (LATINICA — bez preslovljavanja) ───── */

export interface MutualTerminationInput {
  imePrezime: string; // latinica
  jmbg?: string;
  radnoMesto: string; // latinica
  datumUgovora?: string;
  datumPrestanka?: string;
  mesecZarade?: string;
  broj?: string;
  datum?: string;
  mesto?: string;
  potpisPoslodavac?: string;
}

const MUTUAL_SECRETS = [
  'Sadržaj ugovora koje je zaključio Poslodavac, u šta se ubrajaju i podaci o cenama, rabatima, rokovima plaćanja itd,',
  'Podatke o imenima kupaca,',
  'Podatke o imenima dobavljača,',
  'Podatke koji se odnose na poslovanje privrednog društva Servoteh d.o.o,',
  'Sadržaj internih pravila, uputstava, pravila poslovanja, standarda,',
  'Know how vezan za proizvodnju, organizaciju, prodaju i druge vidove aktivnosti,',
  'Podatke o nameravanim transakcijama, poslovnim planovima ili postupcima,',
  'Podatke vezane za sudske i upravne postupke,',
  'Lične podatke zaposlenih,',
  'Podatke o zaradama zaposlenih,',
  'Podatke vezane za nagrađivanje zaposlenih,',
  'Svaki drugi podatak koji bi mogao da bude upotrebljen u poslovnoj ili privatnoj komunikaciji, '
    + 'a koji bi mogao da ima uticaja na unapređenje ili očuvanje konkurentnog položaja Poslodavca na tržištu,',
  'Bilo koji drugi podatak za koji Direktor Poslodavca odredi da je poverljiv ili bez posebnog '
    + 'određivanja preduzme mere radi sprečavanja da se nepozvana lica upoznaju sa takvim podatkom,',
  'Bilo koji podatak koji bi za učesnike u pravnom prometu mogao da ima ekonomsku vrednost.',
];

export async function generateMutualTerminationPdf(d: MutualTerminationInput): Promise<PdfResult> {
  const ctx = await openDocument({ broj: d.broj, datum: d.datum, mesto: d.mesto || 'Dobanovci' });
  const { para, bullet, signatures, finalize, advance } = ctx;

  para(
    'Na osnovu člana 177. Zakona o radu (Službeni glasnik RS, br. 24/2005, 61/2005, 54/2009, '
    + '32/2013, 75/2014, 13/2017 — odluka US, 113/2017, 95/2018 — autentično tumačenje) i odredbi '
    + `Pravilnika o radu kod poslodavca, dana ${d.datum || '________'} godine zaključuje se`,
    { gap: 4 },
  );
  para('SPORAZUM', { bold: true, align: 'center', size: 15, gap: 1.2 });
  para('O PRESTANKU RADNOG ODNOSA', { bold: true, align: 'center', size: 11.5, gap: 4 });

  para('Član 1.', { bold: true, align: 'center', gap: 1.2 });
  para(
    `Poslodavac Servoteh d.o.o. Dobanovci i zaposleni ${d.imePrezime}, JMBG ${d.jmbg || '________________'}, `
    + `koji u društvu obavlja poslove ${d.radnoMesto}`
    + `${d.datumUgovora ? `, po Ugovoru o radu od ${d.datumUgovora} godine` : ''}, sporazumeli su se `
    + `da zaposlenom prestane radni odnos dana ${d.datumPrestanka || '________'} godine.`,
  );
  para(
    'Zaključno sa danom prestanka radnog odnosa prestaju sva prava i obaveze iz radnog odnosa '
    + 'kako Zaposlenog tako i Poslodavca, i sa istim danom će se izvršiti odjava sa obaveznog '
    + 'socijalnog osiguranja.',
    { gap: 3 },
  );

  para('Član 2.', { bold: true, align: 'center', gap: 1.2 });
  para(
    `Zaposleni pristaje da mu Poslodavac zaradu ostvarenu za mesec ${d.mesecZarade || '________'} godine `
    + 'isplati u roku od 30 dana od dana prestanka radnog odnosa.',
    { gap: 3 },
  );

  para('Član 3.', { bold: true, align: 'center', gap: 1.2 });
  para(
    'Zaposleni se obavezuje da do datuma prestanka radnog odnosa iz člana 1. ovog sporazuma, te u '
    + 'roku od dve godine računajući od datuma prestanka radnog odnosa iz člana 1. ovog sporazuma '
    + 'ne otkriva ili na neki drugi način, bez pismene saglasnosti ovlašćenog lica kod Poslodavca '
    + '(izuzev podataka koje po službenoj dužnosti zahtevaju ovlašćeni državni organi) neće '
    + 'obelodaniti trećem licu bilo kakve informacije koje predstavljaju poslovnu tajnu, a naročito '
    + 'da neće otkriti ili obelodaniti:',
    { gap: 1.5 },
  );
  MUTUAL_SECRETS.forEach((s) => bullet(s));
  advance(1);
  para(
    'Ukoliko zaposleni postupi suprotno stavu 1. ovog člana biće u obavezi da nadoknadi štetu '
    + 'Poslodavcu koja nastane usled neovlašćenog obelodanjivanja poslovne tajne iz stava 1. ovog člana.',
    { gap: 3 },
  );

  para('Član 4.', { bold: true, align: 'center', gap: 1.2 });
  para(
    'Zaposleni na ovaj način izjavljuje da, osim potraživanja definisanog članom 2. ovog sporazuma, '
    + 'nema u odnosu na Poslodavca bilo kakvih dospelih i nedospelih potraživanja iz radnog odnosa '
    + 'niti prava iz radnog odnosa, kao ni potraživanja po bilo kom drugom ugovornom ili vanugovornom '
    + 'osnovu, a ova njegova izjava se ima smatrati izjavom o opštem otpustu svih i svakog duga koji '
    + 'Poslodavac po bilo kom osnovu može imati prema njemu.',
    { gap: 3 },
  );

  para('Član 5.', { bold: true, align: 'center', gap: 1.2 });
  para(
    'Ugovorne strane su saglasne da su u potpunosti uredile sve svoje obaveze po osnovu radnog '
    + 'odnosa, te da, po izmirenju obaveza definisanih članom 2. ovog sporazuma, Zaposleni nema '
    + 'nikakvih potraživanja prema Poslodavcu, te da se ovaj sporazum ima smatrati vansudskim poravnanjem.',
    { gap: 3 },
  );

  para('Član 6.', { bold: true, align: 'center', gap: 1.2 });
  para(
    'Zaposleni će se sa danom prestanka radnog odnosa razdužiti sa opremom i sredstvima za rad sa '
    + 'kojima je zadužen, o čemu će se sačiniti primopredajni zapisnik.',
    { gap: 3 },
  );

  para('Član 7.', { bold: true, align: 'center', gap: 1.2 });
  para(
    'Zaposleni izjavljuje da je od strane Poslodavca propisno obavešten o posledicama do kojih '
    + 'dolazi u ostvarenju prava za slučaj nezaposlenosti.',
    { gap: 3 },
  );

  para('Član 8.', { bold: true, align: 'center', gap: 1.2 });
  para(
    'Ugovorne strane za slučaj bilo kakvog spora koji nastane po osnovu ovog ugovora ugovaraju '
    + 'nadležnost Prvog opštinskog suda u Beogradu.',
    { gap: 6 },
  );

  para(`U Dobanovcima, ${d.datum || '________'} godine`, { gap: 8 });
  signatures('Zaposleni', d.imePrezime, 'Direktor društva', d.potpisPoslodavac || 'Nenad Jaraković');

  return { blob: finalize(`Sporazum o prestanku radnog odnosa — ${d.imePrezime}`), fileName: `Sporazumni_raskid_${safeName(d.imePrezime)}.pdf` };
}
