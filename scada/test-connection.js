// Brzi test ZIVE PCOM veze sa PLC-om (SAMO CITANJE). Pokreni PRE servis instalacije:
//   node test-connection.js
const { Pcom } = require('./pcom');
const IP = process.env.PLC_IP || '192.168.75.25';
const PORT = parseInt(process.env.PLC_PORT || '502', 10);
const UNIT = parseInt(process.env.PLC_UNIT || '1', 10);

(async () => {
  const p = new Pcom(IP, PORT, UNIT);
  try {
    console.log(`Povezivanje (PCOM) na ${IP}:${PORT} …`);
    await p.connect();
    console.log('VEZA OK');
    const t = await p.readWords(20, 7);
    console.log('Temperature MI20-26 (raw):', t.join(', '));
    const di = await p.readBits('RE', 2, 14);
    console.log('Ulazi I2-15:', di.join(''));
    const ou = await p.readBits('RA', 0, 19);
    console.log('Izlazi O0-18:', ou.join(''));
    console.log('\n✅ PLC odgovara — možeš instalirati servis (npm run service:install).');
  } catch (e) {
    console.error('❌ GREŠKA:', e.message);
    console.error('Proveri: ping ' + IP + ', firewall, i da je PLC na 502 (PCOM).');
  } finally {
    p.close(); setTimeout(() => process.exit(0), 200);
  }
})();
