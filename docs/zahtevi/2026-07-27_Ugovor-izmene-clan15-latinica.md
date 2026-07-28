# Ugovor o radu — izmene generatora (presudio Nenad, 27.07.2026)

Izvor: usmena presuda vlasnika (Nenad Jaraković) 27.07.2026, uz priloženi primer
`2026-07-27_Ugovor-o-radu-neodredjeno-primer.docx` (u istom folderu) i novi tekst člana o
poslovnoj tajni koji je Nenad dostavio ćirilicom.

Zahvaćeni kod: `frontend/src/lib/hr-pdf/contract.ts`, `frontend/src/lib/hr-pdf/cyrillic.ts`,
`frontend/src/app/kadrovska/_components/ugovori/contract-generate.tsx`.

## Odluke

1. **Pismo ugovora = LATINICA.** Ceo generisani „Ugovor o radu" (naslov, članovi, potpisnici,
   futer) štampa se srpskom latinicom. **Ostala HR dokumenta ostaju ćirilica** — rešenja o
   godišnjem odmoru, potvrde o zaposlenju/zaradi, aneksi, rešenja o zasnivanju radnog odnosa,
   sporazumni raskid, materinstvo. Zato deljeni helperi u
   `_components/ugovori/shared.ts` (`stepenSpremeCyr`, `trajanjeCyr`, `formatRsd`, `opisStavke`)
   **nisu menjani** — i dalje vraćaju ćirilicu za ta dokumenta, a generator ugovora njihov izlaz
   propušta kroz novu funkciju `toLatin()` (`hr-pdf/cyrillic.ts`, obrnuta mapa od `toCyrillic`,
   idempotentna za latinični ulaz).

2. **Određeno vreme — uvek sa razlogom.** Prva rečenica člana 1 za tip `odredjeno` glasi:

   > Zaposleni kod Poslodavca zasniva radni odnos na određeno vreme, sa početkom rada na dan
   > {datum} godine u trajanju od {trajanje}, **zbog povećanog obima posla**.

   Razlog je fiksan (nema izbora u UI) — presuda Nenada. Druga rečenica („Zaposleni je dužan da
   stupi na rad …") ostaje nepromenjena.

3. **Član o poslovnoj tajni zamenjen novim tekstom.** Stari član (8 pasusa + lista od 12 stavki
   „Isprave i podaci koji predstavljaju poslovnu tajnu") u celosti je zamenjen tekstom ispod.
   Suštinska pravna promena: umesto „naknade **celokupne** štete uključujući i izmaklu dobit"
   (i prazne crtice „__ evra" iz ranijih papirnih verzija), sada se traži **stvarno nastala i
   dokazana šteta**, uz izričito uređenu odgovornost prema naručiocu/kupcu i postupak utvrđivanja.
   Broj članova ugovora **nije promenjen**: 20 članova bez probnog rada, 21 sa probnim radom;
   numeracija ostaje dinamička (`Član N.`).

## Novi član o poslovnoj tajni — original (ćirilica, kako ga je dao Nenad)

U kod ulazi transliterovan u latinicu, verbatim po sadržaju („know-how" ostaje kako jeste,
„2Д и 3Д" → „2D i 3D").

> Запослени је дужан да за време трајања радног односа, као и након његовог престанка, чува пословну тајну и поверљиве податке Послодавца и његових наручилаца, пословних партнера, купаца и добављача, до којих је дошао током рада или у вези са радом.
>
> Пословном тајном и поверљивим подацима нарочито се сматрају:
>
> 1. техничка, технолошка, пројектна и производна документација;
> 2. пројекти, нацрти, скице, прорачуни, 2Д и 3Д модели, радионичка документација, хидрауличне, пнеуматске и електричне шеме;
> 3. програми, изворни кодови, параметри, софтверска решења, техничке спецификације и упутства;
> 4. технолошки поступци, производне методе, конструктивна решења, узорци, модели, прототипови, проналасци и know-how;
> 5. спецификације материјала, спискови делова, подаци о набавци, добављачима, ценама, понудама и калкулацијама;
> 6. подаци о купцима, наручиоцима, уговорима, условима пословања, роковима, плановима и динамици реализације пројеката;
> 7. подаци о финансијском пословању, потраживањима, обавезама, зарадама, пословним плановима и стратегији Послодавца;
> 8. сви други подаци који нису јавно доступни, имају пословну вредност и чије би неовлашћено откривање, коришћење, умножавање или достављање трећем лицу могло да нанесе штету Послодавцу или његовим пословним партнерима.
>
> Запослени не сме, без претходне писане сагласности Послодавца, податке и документацију из претходног става:
>
> 1. копирати, фотографисати, умножавати или износити из пословних просторија или информационих система Послодавца;
> 2. слати на приватне адресе електронске поште, приватне налоге, уређаје, интернет-сервисе или друга места која Послодавац није одобрио;
> 3. саопштавати, предавати, уступати, објављивати или на други начин чинити доступним неовлашћеним лицима;
> 4. користити за сопствене потребе, за потребе другог послодавца или трећег лица;
> 5. користити у друге сврхе осим ради извршавања радних обавеза код Послодавца.
>
> Запослени је дужан да без одлагања обавести Послодавца о сваком губитку, неовлашћеном приступу, достављању, копирању или другој злоупотреби пословне документације и поверљивих података за коју сазна.
>
> По престанку радног односа или на захтев Послодавца, Запослени је дужан да одмах врати сву документацију, опрему, носаче података, копије, белешке, приступне податке и други материјал који припада Послодавцу, као и да избрише поверљиве податке са приватних уређаја и налога, уколико су се на њима нашли уз одобрење Послодавца.
>
> Обавеза чувања пословне тајне траје и након престанка радног односа, све док конкретни подаци имају својство пословне тајне, односно док на законит начин не постану јавно доступни.
>
> Повреда обавезе чувања пословне тајне и поверљивих података може представљати повреду радне обавезе и основ за отказ уговора о раду, уз спровођење поступка и под условима прописаним Законом о раду и општим актима Послодавца.
>
> Запослени је одговоран за штету коју је на раду или у вези са радом, намерно или крајњом непажњом, проузроковао Послодавцу неовлашћеним прибављањем, коришћењем, умножавањем, откривањем или чињењем доступним пословне тајне и поверљивих података.
>
> У случају такве повреде, Запослени је дужан да Послодавцу накнади стварно насталу и доказану штету, укључујући обичну штету, измаклу корист, оправдане трошкове утврђивања и отклањања последица повреде, као и износе које је Послодавац по том основу био дужан да накнади наручиоцу, купцу или другом трећем лицу, уколико су испуњени законски услови за одговорност Запосленог.
>
> Постојање одговорности Запосленог, околности под којима је штета настала, њена висина и начин накнаде утврђују се у складу са Законом о раду, општим актима Послодавца и споразумом уговорних страна, а уколико споразум није постигнут, пред надлежним судом.
>
> Права на проналасцима, ауторским делима, програмима, техничким решењима и другим резултатима интелектуалног рада које Запослени створи у извршавању својих радних обавеза, по налогу Послодавца или претежним коришћењем средстава, документације и поверљивих података Послодавца, уређују се у складу са законом и другим прописима којима се уређују права интелектуалне својине.

## Napomena o verifikaciji

PDF se generiše u pregledaču (jsPDF + Roboto TTF iz `frontend/public/fonts/`), pa vizuelni smoke
nije izvodljiv headless u CI-ju. Proverena je pokrivenost fonta: Roboto-Regular/Bold sadrže sve
srpske latinične dijakritike (č, ć, š, ž, đ, Č, Ć, Š, Ž, Đ) i navodnike „ ", tako da nema
nedostajućih glifova. Ista odluka upisana je i u 1.0 repo (`docs/ugovor_o_radu_predlog.md`).
