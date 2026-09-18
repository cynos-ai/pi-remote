const name = process.argv[2] ?? "requested suite";
console.error(`${name} is not implemented before its planned development stage.`);
console.error("This command intentionally exits non-zero; it is not a passing placeholder.");
process.exitCode = 1;
