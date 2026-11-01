/** Server-owned phase/generation state contract shared by dispatch and recovery. */
export const CATALOG_PHASE_GENERATIONS=Object.freeze(Object.fromEntries(Object.entries({
 STARTING:['INGESTING'],WAITING:['INGESTING'],INGESTING:['INGESTING','RECONCILING'],
 RECONCILING:['RECONCILING','VERIFIED'],PUBLISHING:['RECONCILING','VERIFIED','PUBLISHED']
}).map(([phase,states])=>[phase,Object.freeze(states)])));
export const CATALOG_PHASE_GENERATION_SQL='('+Object.entries(CATALOG_PHASE_GENERATIONS).map(([phase,states])=>`(e.phase='${phase}' AND g.status IN (${states.map(state=>`'${state}'`).join(',')}))`).join(' OR ')+')';
