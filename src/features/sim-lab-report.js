/* The lab run's `outcome` (report rps/lab@2): transfers, grasps, insertions, the instrument
   events, the watches, torque and timing, from the phase records. */

const r = (v, k = 3) => +v.toFixed(k);

export function summarize({ records, d, nSteps, inst, watch, prop }) {
  const peak = {};
  for (const p of records) for (const [n, v] of Object.entries(p.torque)) peak[n] = Math.max(peak[n] ?? 0, v.peak_Nm);
  const ins = records.filter((p) => p.insertion);
  const w = watch.summary();
  const ev = inst.events.map((e) => ({ ...e }));
  const reached = (id, s) => ev.some((e) => e.station === id && e.state === s);
  const visited = [];
  for (const p of records) if ((p.grasp || p.insertion) && !visited.includes(p.station)) visited.push(p.station);
  return {
    task: 'enzyme screen: liquid handler -> incubator -> reader', prop: prop.body,
    transfers: ins.filter((p) => p.insertion.success).length, transfers_planned: ins.length,
    seated: ins.filter((p) => p.insertion.success).length,
    stations_visited: visited,
    grasps_verified: records.filter((p) => p.grasp?.verified).map((p) => p.phase),
    contact_gap_mm: records.filter((p) => p.grasp).map((p) => p.grasp.contact_gap_mm),
    carry_held: records.filter((p) => p.carry_held != null).map((p) => p.carry_held),
    insertions: ins.map((p) => ({ phase: p.phase, ...p.insertion })),
    instrument_events: ev,
    incubated: reached('inc', 'done'), read: reached('reader', 'done'),
    puck_path: w.puck_path, puck_seated_at: w.puck_seated_at,
    interlock_min_mm: w.interlock_min_mm, interlock_station: w.interlock_station,
    nav_clearance_min_mm: w.nav_clearance_min_mm, nav_clearance_to: w.nav_clearance_to,
    scenery_contacts: w.scenery_contacts,
    peak_torque_Nm: peak,
    peak_torque_max_Nm: r(Math.max(0, ...Object.values(peak))),
    saturated: [...new Set(records.flatMap((p) => Object.keys(p.torque).filter((k) => p.torque[k].saturated)))],
    over_usable: [...new Set(records.flatMap((p) => Object.keys(p.torque).filter((k) => p.torque[k].over_usable)))],
    self_collision_pairs: [...new Set(records.flatMap((p) => Object.keys(p.self_collisions)))],
    worst_carry_tilt_deg: r(Math.max(0, ...records.filter((p) => p.carry_held).map((p) => p.puck.tilt_deg)), 2),
    peak_held_tilt_deg: w.worst_held_tilt_deg,
    complete: w.puck_seated_at === 'reader' && reached('inc', 'done') && reached('reader', 'done'),
    sim_seconds: r(d.time), steps: nSteps,
  };
}
