const auditPackagedApp = require("./audit-packaged-app.cjs");
const adHocSign = require("./adhoc-sign.cjs");

/** afterPack 组合钩子：先审计产物，最后再做 macOS 临时签名（签名后不得再改 bundle）。 */
module.exports = async function afterPack(context) {
  await auditPackagedApp(context);
  await adHocSign(context);
};
