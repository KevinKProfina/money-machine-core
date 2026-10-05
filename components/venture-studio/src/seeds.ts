/**
 * Offline seed catalog: used when no ANTHROPIC_API_KEY is set so the pipeline runs
 * end-to-end without network. Every venture created from here is flagged
 * `source: 'seed'`. Content is hand-written / template-generated, original, and kept
 * free of advice, guarantees and social proof.
 */
import type { Critic, Idea, LandingCopy } from './types.js';

export type Seed = {
  key: string;
  idea: Idea;
  critic: Critic;
  copy?: LandingCopy;
  /** Markdown for digital products, full HTML for micro-tools. */
  product?: () => string;
};

const self = (step: string, why = 'automatable by the studio') => ({ step, actor: 'self' as const, why });
const human = (step: string, why: string) => ({ step, actor: 'human' as const, why });

const commonSteps = [
  self('Write the product content'),
  self('Render landing page and product files'),
  self('Host static files on the configured site'),
  self('Create payment link via Stripe API'),
  self('Measure sales via Stripe API'),
];

// ---------------- micro-tool: Stundensatz-Rechner ----------------
function stundensatzTool(): string {
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stundensatz-Rechner für Freelancer</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:0 auto;padding:16px;color:#1d1d1f;background:#fff}
label{display:block;margin-top:12px;font-weight:600}input{width:100%;padding:8px;font-size:1rem;border:1px solid #ccc;border-radius:6px}
.out{margin-top:20px;padding:16px;background:#f3f6fb;border-radius:10px}.big{font-size:1.8rem;font-weight:700}
small{color:#5f6368}table{width:100%;border-collapse:collapse;margin-top:8px}td{padding:4px 0;border-bottom:1px solid #e3e3e3}
@media (prefers-color-scheme:dark){body{background:#151617;color:#eee}.out{background:#20242b}input{background:#202124;color:#eee;border-color:#444}}
</style>
</head>
<body>
<h1>Stundensatz-Rechner</h1>
<p>Rechnet aus, welchen Netto-Stundensatz (vor Steuern) du brauchst, um deine geplanten Jahreskosten
und deinen Ziel-Betrag für den Lebensunterhalt zu decken – auf Basis realistisch abrechenbarer Stunden.
Alle Berechnungen laufen nur in deinem Browser, es werden keine Daten gesendet. Ergebnis ist eine
Rechenhilfe, keine Steuer- oder Finanzberatung.</p>
<label for="target">Ziel-Betrag pro Jahr für Lebensunterhalt und Rücklagen (€)</label>
<input id="target" type="number" min="0" step="100" value="42000">
<label for="costs">Betriebskosten pro Jahr (Software, Hardware, Versicherungen, Büro) (€)</label>
<input id="costs" type="number" min="0" step="100" value="6000">
<label for="insurance">Kranken- und Altersvorsorge pro Jahr (€)</label>
<input id="insurance" type="number" min="0" step="100" value="9000">
<label for="weeks">Urlaubs- und Feiertagswochen pro Jahr</label>
<input id="weeks" type="number" min="0" max="52" step="1" value="7">
<label for="sick">Krankheitstage pro Jahr (geschätzt)</label>
<input id="sick" type="number" min="0" max="365" step="1" value="8">
<label for="hours">Arbeitsstunden pro Woche</label>
<input id="hours" type="number" min="1" max="100" step="1" value="40">
<label for="billable">Anteil abrechenbarer Stunden (%)</label>
<input id="billable" type="number" min="1" max="100" step="1" value="65">
<div class="out" aria-live="polite">
<div>Benötigter Stundensatz (netto, vor Steuern):</div>
<div class="big" id="rate">–</div>
<table>
<tr><td>Abrechenbare Stunden pro Jahr</td><td id="bh">–</td></tr>
<tr><td>Zu deckende Summe pro Jahr</td><td id="sum">–</td></tr>
<tr><td>Entspricht Tagessatz (8 h)</td><td id="day">–</td></tr>
</table>
<small>Hinweis: Einkommensteuer und ggf. Umsatzsteuer sind nicht enthalten. Lass deine Zahlen bei Bedarf von einer Steuerberatung prüfen.</small>
</div>
<script>
(function(){
  var ids=['target','costs','insurance','weeks','sick','hours','billable'];
  var fmt=new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'});
  function v(id){var n=parseFloat(document.getElementById(id).value);return isFinite(n)&&n>=0?n:0;}
  function calc(){
    var workWeeks=Math.max(0,52-v('weeks'));
    var hoursPerDay=v('hours')/5;
    var grossHours=Math.max(0,workWeeks*v('hours')-v('sick')*hoursPerDay);
    var billableHours=grossHours*Math.min(100,v('billable'))/100;
    var total=v('target')+v('costs')+v('insurance');
    var rate=billableHours>0?total/billableHours:0;
    document.getElementById('rate').textContent=billableHours>0?fmt.format(rate):'Bitte Eingaben prüfen';
    document.getElementById('bh').textContent=Math.round(billableHours)+' h';
    document.getElementById('sum').textContent=fmt.format(total);
    document.getElementById('day').textContent=billableHours>0?fmt.format(rate*8):'–';
    try{localStorage.setItem('stundensatz',JSON.stringify(ids.map(function(i){return v(i);})));}catch(e){}
  }
  try{var saved=JSON.parse(localStorage.getItem('stundensatz')||'null');if(saved&&saved.length===ids.length){ids.forEach(function(i,k){document.getElementById(i).value=saved[k];});}}catch(e){}
  ids.forEach(function(i){document.getElementById(i).addEventListener('input',calc);});
  calc();
})();
</script>
</body>
</html>
`;
}

// ---------------- micro-tool: Meeting Cost Timer ----------------
function meetingCostTool(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meeting Cost Timer</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:620px;margin:0 auto;padding:16px;background:#fff;color:#1d1d1f}
label{display:block;margin-top:10px;font-weight:600}input,select{width:100%;padding:8px;font-size:1rem;border:1px solid #ccc;border-radius:6px}
.cost{font-size:3rem;font-weight:800;margin:16px 0 0}.time{color:#5f6368}button{margin:12px 8px 0 0;padding:10px 18px;font-size:1rem;border-radius:8px;border:0;background:#0b57d0;color:#fff;cursor:pointer}
button.sec{background:#e8eaed;color:#1d1d1f}ul{padding-left:18px}
@media (prefers-color-scheme:dark){body{background:#151617;color:#eee}input,select{background:#202124;color:#eee;border-color:#444}button.sec{background:#33363b;color:#eee}}
</style>
</head>
<body>
<h1>Meeting Cost Timer</h1>
<p>Shows the running cost of a meeting from the number of attendees and an average loaded hourly cost.
Everything runs locally in your browser; nothing is sent anywhere.</p>
<label for="people">Attendees</label><input id="people" type="number" min="1" max="500" value="6">
<label for="rate">Average loaded cost per person and hour</label><input id="rate" type="number" min="0" step="5" value="60">
<label for="cur">Currency</label><select id="cur"><option>EUR</option><option>USD</option><option>GBP</option><option>CHF</option></select>
<div class="cost" id="cost">0</div><div class="time" id="time">00:00:00</div>
<button id="start">Start</button><button id="pause" class="sec">Pause</button><button id="reset" class="sec">Reset</button><button id="log" class="sec">Save to log</button>
<h2>Log</h2><ul id="list"></ul>
<script>
(function(){
  var elapsed=0,startedAt=null,timer=null;
  function $(id){return document.getElementById(id);}
  function num(id){var n=parseFloat($(id).value);return isFinite(n)&&n>0?n:0;}
  function total(){return elapsed+(startedAt?Date.now()-startedAt:0);}
  function fmtTime(ms){var s=Math.floor(ms/1000);var h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60;return [h,m,r].map(function(x){return String(x).padStart(2,'0');}).join(':');}
  function money(x){return new Intl.NumberFormat('en-IE',{style:'currency',currency:$('cur').value}).format(x);}
  function render(){var ms=total();$('cost').textContent=money(num('people')*num('rate')*ms/3600000);$('time').textContent=fmtTime(ms);}
  $('start').onclick=function(){if(!startedAt){startedAt=Date.now();timer=setInterval(render,250);}};
  $('pause').onclick=function(){if(startedAt){elapsed+=Date.now()-startedAt;startedAt=null;clearInterval(timer);render();}};
  $('reset').onclick=function(){elapsed=0;startedAt=null;clearInterval(timer);render();};
  $('log').onclick=function(){var li=document.createElement('li');li.textContent=new Date().toLocaleString()+' – '+fmtTime(total())+' – '+num('people')+' people – '+$('cost').textContent;$('list').prepend(li);
    try{var l=JSON.parse(localStorage.getItem('mct-log')||'[]');l.unshift(li.textContent);localStorage.setItem('mct-log',JSON.stringify(l.slice(0,50)));}catch(e){}};
  try{JSON.parse(localStorage.getItem('mct-log')||'[]').forEach(function(t){var li=document.createElement('li');li.textContent=t;$('list').appendChild(li);});}catch(e){}
  ['people','rate','cur'].forEach(function(i){$(i).addEventListener('input',render);});
  render();
})();
</script>
</body>
</html>
`;
}

// ---------------- digital product: E-Mail-Vorlagen Handwerk ----------------
const HANDWERK_TEMPLATES: Array<[string, string, string]> = [
  ['Anfrage bestätigen', 'Eingangsbestätigung einer Kundenanfrage', 'vielen Dank für Ihre Anfrage zu [Leistung] vom [Datum]. Wir haben sie erhalten und melden uns bis spätestens [Datum] mit einem Terminvorschlag für die Besichtigung oder mit Rückfragen.\n\nDamit wir uns gut vorbereiten können, schicken Sie uns gern vorab Fotos der betroffenen Stelle und – falls vorhanden – Maße oder Pläne.'],
  ['Besichtigungstermin vorschlagen', 'Terminvorschlag vor Ort', 'gern sehen wir uns die Situation bei Ihnen vor Ort an. Wir könnten an folgenden Terminen vorbeikommen:\n\n- [Datum], [Uhrzeit]\n- [Datum], [Uhrzeit]\n\nDie Besichtigung dauert etwa [Dauer] Minuten. Bitte geben Sie uns kurz Bescheid, welcher Termin passt, oder schlagen Sie einen anderen vor.'],
  ['Angebot senden', 'Begleittext zum Angebot', 'anbei erhalten Sie unser Angebot Nr. [Nummer] für [Leistung]. Das Angebot ist bis [Datum] gültig.\n\nKurz zusammengefasst:\n- Leistungsumfang: [kurze Beschreibung]\n- Voraussichtliche Ausführung: [Zeitraum]\n- Gesamtbetrag: [Betrag] (Details im Anhang)\n\nWenn Sie Fragen zu einzelnen Positionen haben, rufen Sie uns gern an oder antworten Sie einfach auf diese E-Mail.'],
  ['Angebot nachfassen', 'Freundliche Erinnerung an ein offenes Angebot', 'vor [Anzahl] Tagen haben wir Ihnen unser Angebot für [Leistung] geschickt. Wir wollten kurz nachfragen, ob Sie noch Fragen haben oder etwas angepasst werden soll.\n\nFür unsere Planung wäre eine kurze Rückmeldung bis [Datum] hilfreich. Falls sich Ihr Vorhaben erledigt hat, ist das natürlich auch in Ordnung – dann schließen wir den Vorgang.'],
  ['Auftrag bestätigen', 'Auftragsbestätigung mit Eckdaten', 'vielen Dank für Ihren Auftrag. Hiermit bestätigen wir die Ausführung von [Leistung] gemäß Angebot Nr. [Nummer] vom [Datum].\n\nGeplanter Beginn: [Datum]\nVoraussichtliche Dauer: [Dauer]\nAnsprechpartner vor Ort: [Name], Telefon [Nummer]\n\nBitte sorgen Sie dafür, dass der Arbeitsbereich am ersten Tag zugänglich ist und [Vorbereitung, z. B. Möbel abgerückt] ist.'],
  ['Termin verschieben (durch Betrieb)', 'Terminverschiebung ehrlich erklären', 'leider müssen wir den vereinbarten Termin am [Datum] verschieben, weil [kurzer, ehrlicher Grund, z. B. Materiallieferung verzögert]. Das tut uns leid.\n\nWir können Ihnen folgende Ersatztermine anbieten:\n- [Datum]\n- [Datum]\n\nBitte geben Sie uns Bescheid, welcher Termin für Sie passt.'],
  ['Termin verschieben (durch Kunde)', 'Antwort auf Verschiebungswunsch', 'kein Problem, wir verschieben den Termin gern. Der bisherige Termin am [Datum] ist storniert.\n\nNeu vorgeschlagen: [Datum], [Uhrzeit]. Wenn das nicht passt, nennen Sie uns bitte zwei bis drei Alternativen in den nächsten [Anzahl] Wochen.'],
  ['Material verzögert sich', 'Information über Lieferverzug', 'wir möchten Sie frühzeitig informieren: Das Material für Ihren Auftrag ([Material]) wird laut unserem Lieferanten erst am [Datum] geliefert.\n\nDadurch verschiebt sich der Arbeitsbeginn voraussichtlich auf den [Datum]. Sobald wir eine verbindliche Lieferbestätigung haben, melden wir uns erneut.'],
  ['Zusatzleistung anbieten', 'Nachtrag vor der Ausführung abstimmen', 'bei den Arbeiten ist uns aufgefallen, dass [Befund]. Um das fachgerecht zu beheben, wäre zusätzlich [Leistung] nötig.\n\nDie Mehrkosten betragen voraussichtlich [Betrag]. Wir führen die Zusatzarbeiten nur nach Ihrer ausdrücklichen Freigabe aus. Bitte antworten Sie mit „Freigabe“ oder rufen Sie uns an, wenn Sie Fragen haben.'],
  ['Arbeiten abgeschlossen', 'Abschlussinformation und Abnahme', 'die Arbeiten an [Leistung] sind abgeschlossen. Wir würden gern einen kurzen Abnahmetermin mit Ihnen vereinbaren, um alles gemeinsam anzuschauen.\n\nVorschlag: [Datum], [Uhrzeit]. Pflegehinweise zu [Material/Anlage] finden Sie im Anhang.'],
  ['Rechnung senden', 'Begleittext zur Rechnung', 'anbei erhalten Sie die Rechnung Nr. [Nummer] für [Leistung]. Der Rechnungsbetrag von [Betrag] ist zahlbar bis [Datum] auf das in der Rechnung angegebene Konto.\n\nVielen Dank für den Auftrag und die gute Zusammenarbeit.'],
  ['Zahlungserinnerung', 'Freundliche erste Erinnerung', 'bei der Durchsicht unserer Buchhaltung ist uns aufgefallen, dass die Rechnung Nr. [Nummer] vom [Datum] über [Betrag] noch offen ist. Sicher ist das nur im Alltag untergegangen.\n\nWir bitten um Überweisung bis [Datum]. Falls Sie bereits gezahlt haben, betrachten Sie diese Nachricht bitte als gegenstandslos.'],
  ['Reklamation beantworten', 'Erste Reaktion auf eine Beschwerde', 'danke, dass Sie uns auf [Problem] hingewiesen haben. Wir nehmen das ernst und möchten uns die Sache schnell selbst ansehen.\n\nWir können am [Datum] zwischen [Uhrzeit] und [Uhrzeit] vorbeikommen. Bitte schicken Sie uns, wenn möglich, vorab ein Foto. Nach der Besichtigung besprechen wir mit Ihnen das weitere Vorgehen.'],
  ['Wartung anbieten', 'Hinweis auf fällige Wartung', 'die letzte Wartung Ihrer [Anlage] liegt jetzt [Zeitraum] zurück. Der Hersteller empfiehlt eine Wartung alle [Intervall].\n\nWenn Sie möchten, vereinbaren wir einen Termin. Der Aufwand liegt erfahrungsgemäß bei [Dauer]; die Kosten richten sich nach unserem aktuellen Wartungsangebot, das wir Ihnen gern zusenden.'],
  ['Absage einer Anfrage', 'Höfliche Absage bei fehlender Kapazität', 'vielen Dank für Ihre Anfrage zu [Leistung]. Leider können wir den Auftrag im gewünschten Zeitraum nicht übernehmen, weil unsere Kapazitäten bis [Monat] ausgelastet sind.\n\nWenn sich Ihr Zeitplan verschieben lässt, melden Sie sich gern erneut. Wir wünschen Ihnen viel Erfolg mit Ihrem Vorhaben.'],
];

function handwerkMarkdown(): string {
  const parts = [
    '# 15 E-Mail-Vorlagen für Handwerksbetriebe',
    '',
    'Diese Sammlung enthält 15 sofort nutzbare E-Mail-Vorlagen für typische Situationen im Kundenkontakt eines Handwerksbetriebs – von der Anfrage bis zur Zahlungserinnerung. Platzhalter stehen in eckigen Klammern, z. B. `[Datum]`. Ersetze sie vor dem Versand und passe Ton und Anrede an deinen Betrieb an.',
    '',
    '## So nutzt du die Vorlagen',
    '',
    '1. Kopiere die passende Vorlage in dein E-Mail-Programm oder lege sie dort als Textbaustein an.',
    '2. Ersetze alle Platzhalter in eckigen Klammern. Suche zum Schluss nach `[`, damit keiner übrig bleibt.',
    '3. Prüfe Termine, Beträge und Fristen gegen dein Angebot bzw. deine Rechnung.',
    '4. Die Vorlagen sind Formulierungshilfen und keine Rechtsberatung; für Mahnverfahren, AGB oder Gewährleistungsfragen gilt das jeweils geltende Recht.',
    '',
    '## Inhaltsverzeichnis',
    '',
    ...HANDWERK_TEMPLATES.map(([t], i) => `${i + 1}. ${t}`),
    '',
  ];
  HANDWERK_TEMPLATES.forEach(([title, purpose, text], i) => {
    parts.push(`## ${i + 1}. ${title}`, '', `*Wofür:* ${purpose}`, '', `**Betreff:** ${title} – [Projekt/Adresse]`, '', 'Guten Tag [Anrede] [Name],', '', text, '', 'Mit freundlichen Grüßen', '[Ihr Name]', '[Betrieb] · [Telefon] · [E-Mail]', '');
  });
  parts.push(
    '## Checkliste vor dem Versand',
    '',
    '- Alle Platzhalter ersetzt?',
    '- Richtige Angebots- oder Rechnungsnummer?',
    '- Fristen als konkretes Datum angegeben (nicht „in zwei Wochen“)?',
    '- Anhang wirklich angehängt?',
    '- Ton passend zur bisherigen Kommunikation (Sie/Du)?',
    '',
  );
  return parts.join('\n');
}

// ---------------- digital product: Remote team rituals ----------------
const RITUALS: Array<[string, string, string[]]> = [
  ['Weekly kickoff (25 min)', 'Align on the few outcomes that matter this week.', ['Round: one sentence each – what would make this week a success for you? (5 min)', 'Review last week\'s outcomes: done / moved / dropped (5 min)', 'Pick max. 3 team outcomes for this week, each with one owner (10 min)', 'Risks and blockers – who needs help from whom? (5 min)']],
  ['Async daily check-in', 'Replace a daily call with a written thread.', ['Yesterday: what moved forward (one line)', 'Today: the one thing I will finish', 'Blocked by: name the person or decision you need', 'Rule: reply to blockers within your working day']],
  ['Decision log entry', 'Make decisions findable for people in other time zones.', ['Decision: one sentence', 'Context: why now, what problem it solves', 'Options considered and why they were not chosen', 'Owner and date; how to revisit it']],
  ['Fortnightly retro (45 min)', 'Improve how the team works, not just what it ships.', ['Silent writing: what helped, what hurt, what puzzled us (10 min)', 'Cluster and vote – pick top 2 themes (10 min)', 'Discuss each theme: root cause, one small experiment (20 min)', 'Assign an owner and a check date for each experiment (5 min)']],
  ['Demo hour (monthly, 60 min)', 'Show finished work and celebrate progress.', ['Each demo max. 7 minutes, live or recorded', 'Show the user-visible result first, internals second', 'Questions in a doc for async answers', 'Record the session for other time zones']],
  ['1:1 agenda (30 min)', 'A shared agenda the report owns.', ['How are you, honestly? (5 min)', 'Topics from the report (15 min)', 'Topics from the lead (5 min)', 'Agreed follow-ups written in the shared doc (5 min)']],
  ['Onboarding buddy plan (first 2 weeks)', 'Give new people a person, not just a wiki.', ['Day 1: 30-min welcome call, tool access check', 'Days 2–5: one paired task per day', 'Week 2: first independent task with buddy review', 'End of week 2: feedback round – what was confusing?']],
  ['Handoff note across time zones', 'End-of-day note so work continues while you sleep.', ['Status: what is done, what is half-done (with links)', 'Next step for whoever picks it up', 'Open questions and who can answer them', 'Do not: things that look done but are not']],
  ['Quarterly planning workshop (2 × 90 min)', 'Choose a small set of goals and say no to the rest.', ['Session 1: review last quarter, collect candidate goals', 'Score candidates by impact and effort, silently first', 'Session 2: pick 3 goals, define how progress will be visible', 'Write the explicit "not this quarter" list']],
  ['Meeting-free focus day agreement', 'Protect deep work as a team norm.', ['Pick one weekday without recurring meetings', 'Status on chat tools: focus mode, replies next morning', 'Exceptions only for incidents – define what counts as one', 'Review the agreement after one month']],
];

function ritualsMarkdown(): string {
  const parts = [
    '# Remote Team Rituals Kit',
    '',
    'Ten ready-to-use meeting and async templates for small remote or hybrid teams. Copy them into your wiki, docs tool or chat app and adapt the timings. Each template states its purpose, a time-boxed agenda or structure, and facilitation tips.',
    '',
    '## How to introduce rituals without overload',
    '',
    '- Start with two rituals (weekly kickoff + async daily check-in), add more only after a month.',
    '- Give every ritual an owner who may cancel it when it stops being useful.',
    '- Review the set of rituals in each retro: keep, change or drop.',
    '- Prefer written formats when people work across more than four hours of time-zone difference.',
    '',
    '## Contents',
    '',
    ...RITUALS.map(([t], i) => `${i + 1}. ${t}`),
    '',
  ];
  RITUALS.forEach(([title, purpose, steps], i) => {
    parts.push(
      `## ${i + 1}. ${title}`,
      '',
      `**Purpose:** ${purpose}`,
      '',
      '**Structure:**',
      '',
      ...steps.map((s) => `- ${s}`),
      '',
      '**Facilitation tips:**',
      '',
      '- Share the template at least one day before so people can prepare.',
      '- Time-box strictly; park off-topic items in a visible list.',
      '- Write outcomes into the shared doc during the session, not afterwards.',
      '',
      '**Copy-paste template:**',
      '',
      '```',
      `${title}`,
      `Date: ____   Facilitator: ____   Notes: ____`,
      ...steps.map((s, k) => `${k + 1}) ${s.replace(/\s*\(.*?\)\s*$/, '')}: ____`),
      'Follow-ups (owner, due date): ____',
      '```',
      '',
    );
  });
  return parts.join('\n');
}

export const SEEDS: Seed[] = [
  {
    key: 'stundensatz-rechner',
    idea: {
      title: 'Stundensatz-Rechner für Freelancer',
      slug: 'stundensatz-rechner',
      category: 'micro-tool',
      productType: 'Browser-Rechner (einzelne HTML-Datei)',
      audience: 'Selbstständige und Freelancer in Deutschland',
      problem: 'Viele Selbstständige kalkulieren ihren Stundensatz ohne Urlaub, Krankheit und nicht abrechenbare Zeit.',
      deliverableOutline: ['Interaktiver Rechner mit 7 Eingaben', 'Tagessatz-Umrechnung', 'Speichert Eingaben lokal im Browser', 'Funktioniert offline'],
      price: 7,
      language: 'de',
      keywords: ['stundensatz berechnen', 'freelancer stundensatz', 'tagessatz rechner', 'selbstständig kalkulation'],
      whyPay: 'Spart Tabellenbastelei und macht nicht abrechenbare Zeit sichtbar.',
      autonomy: { steps: commonSteps, autonomyScore: 1 },
    },
    critic: { score: 64, demandSignals: 'Steady search interest for hourly-rate calculators.', competition: 'Many free calculators exist.', buildability: 'Fully buildable.', legalRisk: 'Low if framed as a calculator, not advice.', reasons: ['seed catalog baseline score'] },
    copy: {
      headline: 'Stundensatz-Rechner für Freelancer',
      subheadline: 'Rechne in zwei Minuten aus, welchen Stundensatz du für deine geplanten Kosten wirklich brauchst – inklusive Urlaub, Krankheit und nicht abrechenbarer Zeit.',
      benefits: ['Berücksichtigt Urlaub, Feiertage und Krankheitstage', 'Zeigt abrechenbare Stunden pro Jahr', 'Läuft komplett im Browser, keine Datenübertragung', 'Einmal kaufen, offline nutzen'],
      outline: ['7 Eingabefelder', 'Ergebnis: Stunden- und Tagessatz', 'Hinweise zu nicht enthaltenen Steuern'],
      faq: [
        { q: 'Ist das eine Steuer- oder Finanzberatung?', a: 'Nein. Der Rechner ist eine Rechenhilfe mit deinen eigenen Annahmen.' },
        { q: 'Werden meine Daten gespeichert?', a: 'Nur lokal in deinem Browser. Es wird nichts an einen Server gesendet.' },
        { q: 'Wie erhalte ich das Produkt?', a: 'Direkt nach dem Kauf wirst du zur Download-Seite weitergeleitet.' },
      ],
      metaDescription: 'Stundensatz-Rechner für Freelancer: Urlaub, Krankheit und abrechenbare Zeit berücksichtigen. Läuft im Browser.',
    },
    product: stundensatzTool,
  },
  {
    key: 'handwerk-email-vorlagen',
    idea: {
      title: '15 E-Mail-Vorlagen für Handwerksbetriebe',
      slug: 'handwerk-email-vorlagen',
      category: 'digital-product',
      productType: 'Vorlagenpaket (Markdown/HTML)',
      audience: 'Kleine Handwerksbetriebe ohne Büroangestellte',
      problem: 'Kundenkommunikation kostet Zeit am Abend; Formulierungen für unangenehme Situationen fehlen.',
      deliverableOutline: ['15 Vorlagen von Anfrage bis Zahlungserinnerung', 'Platzhalter-System', 'Checkliste vor dem Versand'],
      price: 12,
      language: 'de',
      keywords: ['email vorlagen handwerk', 'angebot nachfassen vorlage', 'zahlungserinnerung vorlage handwerker', 'kundenkommunikation handwerk'],
      whyPay: 'Spart Formulierungszeit und sorgt für einen professionellen, einheitlichen Ton.',
      autonomy: { steps: commonSteps, autonomyScore: 1 },
    },
    critic: { score: 66, demandSignals: 'Template searches with commercial intent.', competition: 'Some free single templates, few curated packs.', buildability: 'Fully buildable.', legalRisk: 'Low; no legal advice.', reasons: ['seed catalog baseline score'] },
    copy: {
      headline: '15 E-Mail-Vorlagen für Handwerksbetriebe',
      subheadline: 'Fertige Formulierungen für Anfrage, Angebot, Terminverschiebung, Abnahme und Zahlungserinnerung – zum Kopieren und Anpassen.',
      benefits: ['15 Vorlagen für typische Kundensituationen', 'Klare Platzhalter in eckigen Klammern', 'Freundlich-sachlicher Ton', 'Checkliste vor dem Versand'],
      outline: HANDWERK_TEMPLATES.map(([t]) => t),
      faq: [
        { q: 'In welchem Format erhalte ich die Vorlagen?', a: 'Als Webseite zum Kopieren und als Markdown-Datei.' },
        { q: 'Sind die Vorlagen rechtlich geprüft?', a: 'Nein. Es sind Formulierungshilfen, keine Rechtsberatung.' },
        { q: 'Kann ich die Texte anpassen?', a: 'Ja, du kannst sie für deinen Betrieb frei anpassen und verwenden.' },
      ],
      metaDescription: '15 E-Mail-Vorlagen für Handwerker: Anfrage bestätigen, Angebot nachfassen, Termin verschieben, Zahlungserinnerung.',
    },
    product: handwerkMarkdown,
  },
  {
    key: 'balkonkraftwerk-vergleich',
    idea: {
      title: 'Vergleichsportal für Steckersolargeräte',
      slug: 'steckersolar-vergleich',
      category: 'content-site',
      productType: 'Content-Website mit Vergleichstabellen',
      audience: 'Mieter und Eigentümer, die ein Steckersolargerät kaufen wollen',
      problem: 'Unübersichtlicher Markt, Regeln ändern sich.',
      deliverableOutline: ['Vergleichstabellen', 'Ratgeberartikel', 'Laufende Aktualisierung'],
      price: 0.01,
      language: 'de',
      keywords: ['steckersolargerät vergleich', 'balkonsolar test'],
      whyPay: 'Monetarisierung über Partnerprogramme.',
      autonomy: {
        steps: [
          self('Write guide articles'),
          self('Host static pages'),
          human('Apply for affiliate programs', 'requires account, identity and tax data'),
          human('Verify product data and prices regularly', 'needs real-world checks and up-to-date manufacturer data'),
          human('Handle affiliate payouts and tax', 'bank account and bookkeeping'),
        ],
        autonomyScore: 0.4,
      },
    },
    critic: { score: 55, demandSignals: 'High search volume.', competition: 'Very high.', buildability: 'Partly.', legalRisk: 'Medium (affiliate disclosure).', reasons: ['seed catalog baseline score'] },
  },
  {
    key: 'remote-team-rituals-kit',
    idea: {
      title: 'Remote Team Rituals Kit',
      slug: 'remote-team-rituals-kit',
      category: 'digital-product',
      productType: 'Template pack (Markdown/HTML)',
      audience: 'Team leads of small remote or hybrid teams',
      problem: 'Remote teams either over-meet or lose alignment; leads lack ready-made formats.',
      deliverableOutline: ['10 ritual templates with agendas', 'Facilitation tips', 'Copy-paste blocks'],
      price: 9,
      language: 'en',
      keywords: ['remote team meeting templates', 'retro template', 'async standup template', 'team rituals'],
      whyPay: 'Saves preparation time and gives a coherent set of formats instead of scattered blog posts.',
      autonomy: { steps: commonSteps, autonomyScore: 1 },
    },
    critic: { score: 61, demandSignals: 'Search interest for meeting templates.', competition: 'Many free templates; curated kits are fewer.', buildability: 'Fully buildable.', legalRisk: 'Low.', reasons: ['seed catalog baseline score'] },
    copy: {
      headline: 'Remote Team Rituals Kit',
      subheadline: 'Ten ready-to-use meeting and async templates for small remote teams – kickoff, async check-in, retro, decision log, handoffs and more.',
      benefits: ['10 time-boxed templates', 'Async-first formats for distributed teams', 'Facilitation tips for every ritual', 'Copy-paste blocks for your docs tool'],
      outline: RITUALS.map(([t]) => t),
      faq: [
        { q: 'What format is it?', a: 'A web page plus a Markdown file you can paste into most docs and wiki tools.' },
        { q: 'Does it include coaching or calls?', a: 'No. It is a self-service template pack.' },
        { q: 'How do I get it?', a: 'After checkout you are redirected to the download page.' },
      ],
      metaDescription: 'Remote Team Rituals Kit: 10 templates for weekly kickoff, async check-ins, retros, decision logs and handoffs.',
    },
    product: ritualsMarkdown,
  },
  {
    key: 'meeting-cost-timer',
    idea: {
      title: 'Meeting Cost Timer',
      slug: 'meeting-cost-timer',
      category: 'micro-tool',
      productType: 'Browser tool (single HTML file)',
      audience: 'Team leads and project managers',
      problem: 'Meeting cost is invisible, so meetings grow longer and larger.',
      deliverableOutline: ['Live cost counter', 'Start/pause/reset', 'Local log of meetings'],
      price: 5,
      language: 'en',
      keywords: ['meeting cost calculator', 'meeting cost timer', 'cost of meetings'],
      whyPay: 'A polished offline tool that can be shared on screen in meetings.',
      autonomy: { steps: commonSteps, autonomyScore: 1 },
    },
    critic: { score: 52, demandSignals: 'Some interest.', competition: 'Several free web versions exist.', buildability: 'Fully buildable.', legalRisk: 'Low.', reasons: ['seed catalog baseline score', 'free alternatives reduce willingness to pay'] },
    copy: {
      headline: 'Meeting Cost Timer',
      subheadline: 'See what a meeting costs while it runs.',
      benefits: ['Live counter', 'Works offline', 'No data leaves your browser'],
      outline: ['Attendees and hourly cost input', 'Timer with live cost', 'Local meeting log'],
      faq: [{ q: 'Does it send data anywhere?', a: 'No, it runs entirely in your browser.' }],
      metaDescription: 'Meeting Cost Timer: live meeting cost counter that runs in your browser.',
    },
    product: meetingCostTool,
  },
  {
    key: 'cv-feedback-service',
    idea: {
      title: 'CV Feedback Service',
      slug: 'cv-feedback-service',
      category: 'service-listing',
      productType: 'Service listing',
      audience: 'Job seekers',
      problem: 'People want individual feedback on their CV.',
      deliverableOutline: ['Individual written feedback within 48 hours'],
      price: 29,
      language: 'en',
      keywords: ['cv review', 'resume feedback'],
      whyPay: 'Individual attention.',
      autonomy: {
        steps: [
          self('Write listing text'),
          human('Receive and handle personal documents (GDPR)', 'data processing agreement and secure handling needed'),
          human('Answer customer questions and revisions', 'customer support beyond FAQ'),
          human('Quality-check feedback before delivery', 'individual service quality and liability'),
        ],
        autonomyScore: 0.25,
      },
    },
    critic: { score: 50, demandSignals: 'Moderate.', competition: 'High.', buildability: 'Not autonomous.', legalRisk: 'Medium.', reasons: ['seed catalog baseline score'] },
  },
  {
    key: 'sportwetten-guide',
    idea: {
      title: 'Sportwetten-Strategie-Guide',
      slug: 'sportwetten-strategie-guide',
      category: 'digital-product',
      productType: 'E-Book',
      audience: 'Hobby-Tipper',
      problem: 'Verluste bei Sportwetten',
      deliverableOutline: ['Strategien'],
      price: 19,
      language: 'de',
      keywords: ['sportwetten strategie'],
      whyPay: 'Hoffnung auf Gewinne',
      autonomy: { steps: commonSteps, autonomyScore: 1 },
    },
    critic: { score: 70, demandSignals: 'High.', competition: 'High.', buildability: 'Buildable.', legalRisk: 'High (gambling).', reasons: ['seed catalog example of a forbidden category'] },
  },
];

export const seedByKey = (key: string | undefined) => SEEDS.find((s) => s.key === key);
