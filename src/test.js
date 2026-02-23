import ocfl from "@ocfl/ocfl-fs";
const r = ocfl.storage({
  root: ocflConf.ocflPath,
  workspace: ocflConf.ocflScratch,
  ocflVersion: '1.1',
  fixityAlgorithms: ['crc32'],
  layout: {
    extensionName: '000N-path-direct-storage-layout'
  }
});

