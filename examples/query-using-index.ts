import { QueryBuilder } from "../src/QueryBuilder";
import staticqlConfig from "../tests/staticql.config";
import { DataLoader } from "../src/DataLoader";
import { Indexer } from "../src/Indexer";

async function main() {
  // Setup
  const config = (staticqlConfig as any).config || (staticqlConfig as any)._config || (staticqlConfig as any)["config"];
  const loader = new DataLoader(config);
  const indexer = new Indexer(loader, config);

  // Ensure indexes are built and saved (normally done in build step)
  await indexer.buildAll();
  await indexer.saveTo("examples/output");

  // Query using an indexed field (e.g., "name" on "herbs") with indexMode: "only"
  const qbIndexed = new QueryBuilder("herbs", config, loader, [], indexer).options({ indexMode: "only", indexDir: "examples/output" });
  const t1 = Date.now();
  const herbsIndexed = await qbIndexed.where("name", "eq", "ペパーミント").exec();
  const t2 = Date.now();

  console.log("Query result for herbs with name 'ペパーミント' (using index):");
  console.log(herbsIndexed);
  console.log(`Time with index: ${t2 - t1} ms`);

  // Query using an indexed field (e.g., "name" on "herbs") with indexMode: "none" (full scan)
  const qbScan = new QueryBuilder("herbs", config, loader, [], indexer).options({ indexMode: "none" });
  const t3 = Date.now();
  const herbsScan = await qbScan.where("name", "eq", "ペパーミント").exec();
  const t4 = Date.now();

  console.log("Query result for herbs with name 'ペパーミント' (full scan):");
  console.log(herbsScan);
  console.log(`Time with full scan: ${t4 - t3} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
