// Tata letak service map: kolom kiri -> kanan menurut kedalaman panggilan (pemanggil di kiri),
// tujuan eksternal (database, API luar) satu kolom setelah pemanggil terdalamnya, di bawah service di kolom itu
// (bukan kolom terakhir: edge panjang akan lewat di belakang node lain). Siklus tidak membuat kedalaman tak terbatas.

export interface MapNode { id: string; external: boolean; col: number; row: number; x: number; y: number }
export interface MapEdge { source: string; target: string }

export const NODE_W = 168, NODE_H = 52, COL_GAP = 96, ROW_GAP = 22, PAD = 16;

export function layoutMap(services: string[], edges: (MapEdge & { external: boolean })[]) {
  const internal = new Set(services);
  for (const e of edges) { internal.add(e.source); if (!e.external) internal.add(e.target); }
  const externals = new Set(edges.filter((e) => e.external && !internal.has(e.target)).map((e) => e.target));

  // Kedalaman = jalur terpanjang dari service tanpa pemanggil (Bellman-Ford terbatas: maksimal |V| putaran).
  const depth = new Map([...internal].map((id) => [id, 0]));
  const inner = edges.filter((e) => internal.has(e.target) && e.source !== e.target);
  for (let i = 0; i < internal.size; i++) {
    let changed = false;
    for (const e of inner) {
      const d = depth.get(e.source)! + 1;
      if (d > depth.get(e.target)! && d < internal.size) { depth.set(e.target, d); changed = true; }
    }
    if (!changed) break;
  }
  const extCol = new Map<string, number>();
  for (const e of edges) {
    if (!externals.has(e.target)) continue;
    extCol.set(e.target, Math.max(extCol.get(e.target) ?? 0, depth.get(e.source)! + 1));
  }
  const cols = new Map<number, string[]>();
  const put = (id: string, c: number) => { const l = cols.get(c) ?? []; l.push(id); cols.set(c, l); };
  // Urutan dalam kolom mengikuti urutan input (service dengan request terbanyak lebih dulu).
  for (const id of internal) put(id, depth.get(id)!);
  for (const id of externals) put(id, extCol.get(id)!);

  const nodes: MapNode[] = [];
  const tallest = Math.max(1, ...[...cols.values()].map((l) => l.length));
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP;
  for (const [col, ids] of cols) {
    const colH = ids.length * NODE_H + (ids.length - 1) * ROW_GAP;
    ids.forEach((id, row) => nodes.push({
      id, external: externals.has(id), col, row,
      x: PAD + col * (NODE_W + COL_GAP), y: (height - colH) / 2 + row * (NODE_H + ROW_GAP),
    }));
  }
  const ncols = cols.size ? Math.max(...cols.keys()) + 1 : 1;
  return { nodes, width: PAD * 2 + ncols * NODE_W + (ncols - 1) * COL_GAP, height };
}

/** Kurva edge dari sisi kanan node sumber ke sisi kiri node tujuan (atau melengkung balik untuk siklus). */
export function edgePath(a: MapNode, b: MapNode): string {
  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
  if (x2 > x1) {
    const m = (x1 + x2) / 2;
    return `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`;
  }
  // Ke kolom yang sama atau ke kiri: lewat atas.
  const top = Math.min(a.y, b.y) - 18;
  return `M${x1},${y1} C${x1 + 60},${top} ${x2 - 60},${top} ${x2},${y2}`;
}

// Nilai db.system yang umum (OpenTelemetry semconv) + mongoose; node eksternal dengan awalan ini adalah database.
const DB_SYSTEMS = /^(mssql|mysql|mariadb|postgresql|oracle|sqlite|db2|cockroachdb|clickhouse|mongodb|mongoose|redis|memcached|cassandra|couchbase|couchdb|dynamodb|elasticsearch|opensearch|neo4j|firestore|cosmosdb)( ·|$)/i;
/** Label node yang tidak mengirim trace sendiri: database, atau tujuan lain (API luar, dll.). */
export const externalLabel = (name: string) => (DB_SYSTEMS.test(name) ? "database" : "not instrumented");
