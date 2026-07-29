// Pravi Loxone tag-mapu iz LoxAPP3 strukture (data/loxone-structure.json).
// Citanje ide po CONTROL uuid-u (HTTP). Komande: Switch->On/Off, ValueSelector->broj.
// IRoomControllerV2 tempActual/tempTarget zahtevaju WebSocket (faza 2) — za sada mod.

function kindOf(type) {
  switch (type) {
    case 'Switch': return { kind: 'switch', writable: true };
    case 'ValueSelector': return { kind: 'value', writable: true };
    case 'Heatmixer': return { kind: 'analog', writable: false };
    case 'InfoOnlyAnalog': return { kind: 'analog', writable: false };
    case 'IRoomControllerV2': return { kind: 'room', writable: false };
    case 'Radio': return { kind: 'radio', writable: false };
    default: return { kind: 'other', writable: false };
  }
}

function buildLoxoneTags(structure) {
  const controls = structure.controls || [];
  return controls.map(c => {
    const k = kindOf(c.type);
    return {
      key: c.uuid,
      uuid: c.uuid,
      name: c.name,
      room: c.room || '—',
      type: c.type,
      kind: k.kind,
      writable: k.writable,
      states: c.states || {},
    };
  });
}

// Loxone komanda za upis: switch 1/0 -> On/Off; value -> broj
function loxCommand(tag, value) {
  if (tag.kind === 'switch') return value ? 'On' : 'Off';
  return String(value);
}

module.exports = { buildLoxoneTags, loxCommand };
