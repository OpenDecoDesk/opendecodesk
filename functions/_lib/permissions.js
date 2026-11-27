// Roles and permissions (migrations/0089): the ONE list of what can be allowed, and the built-in roles.
// ================================================================================================
// A role says, for each FUNCTION of the back office, how far its users may go:
//   none  hidden: the screen or button isn't there and the server refuses it
//   read  can open and look
//   edit  can add and change
//   full  edit, plus delete, void, refund and write off
// Functions belong to menu ITEMS (the admin's nav hashes) inside MENUS (the nav groups). A menu or an
// item switched off hides everything in it, whatever its functions say.
//
// Admin is locked: always full, never edited. Every other role is a row in `roles`; the built-in ones
// fall back to DEFAULT_ROLES here when their row is missing (an install that hasn't run 0089 yet).
//
// No imports and only `export const` / `export function`: tests load this file as plain source.

export const PERM_LEVELS = ["none", "read", "edit", "full"];
export const permRank = (lvl) => lvl === "full" ? 3 : lvl === "edit" ? 2 : lvl === "read" ? 1 : 0;

// Menus → items (nav hash) → functions [key, label]. Order is the order the Roles screen shows.
export const PERMISSION_AREAS = [
  { key: "home", label: "Home", items: [
    { hash: "home", label: "Home", fns: [["home.counts", "Order counts by step"]] } ] },
  { key: "orders", label: "Orders", items: [
    { hash: "orders", label: "Orders", fns: [
      ["orders.details", "Order details, items and notes"],
      ["orders.stepsEarly", "Steps: blanks, digitizing and approval"],
      ["orders.stepsLate", "Steps: made, QA packed, shipped and completed"],
      ["orders.shipping", "Shipping labels and tracking"],
      ["orders.payments", "Payments, discounts and refunds"],
      ["orders.payOnDelivery", "Set orders to pay on delivery"],
      ["orders.invoices", "Invoices and receipts"],
      ["orders.downloads", "Digital downloads"],
      ["orders.import", "Import orders"]] } ] },
  { key: "customers", label: "Customers", items: [
    { hash: "customers", label: "Customers", fns: [["customers.records", "Customer records"]] } ] },
  { key: "quotes", label: "Quotes", items: [
    { hash: "quotes", label: "Quotes", fns: [["quotes.estimates", "Quotes"]] } ] },
  { key: "discounts", label: "Discount codes", items: [
    { hash: "discounts", label: "Discount codes", fns: [["discounts.codes", "Discount codes"], ["discounts.campaigns", "Email campaigns"]] } ] },
  { key: "runorder", label: "Run Order", items: [
    { hash: "runorder", label: "Run Order", fns: [["run.queue", "Production queue"], ["run.runs", "Start, finish and abort runs"], ["run.markMade", "Mark pieces made"]] } ] },
  { key: "runtransfer", label: "Run Order: DTF transfers", items: [
    { hash: "runtransfer", label: "DTF transfers on Run Order", fns: [["transfer.queue", "Transfer queue and gang sheets"], ["transfer.mark", "Mark received, applied and made"]] } ] },
  { key: "catalog", label: "Catalog", items: [
    { hash: "catalog", label: "Manage catalog", fns: [["catalog.products", "Products"], ["catalog.productFiles", "Digital product files"]] },
    { hash: "setup", label: "Shop setup", fns: [["catalog.shops", "Shops, domains and publishing"]] },
    { hash: "designs", label: "Designs", fns: [["catalog.designs", "Designs"]] },
    { hash: "graphics", label: "Graphics", fns: [["catalog.graphics", "Graphics"]] },
    { hash: "categories", label: "Product categories", fns: [["catalog.categories", "Product categories"]] },
    { hash: "locations", label: "Decoration locations", fns: [["catalog.locations", "Decoration locations"]] },
    { hash: "brandrules", label: "Brand rules", fns: [["catalog.brandrules", "Brand rules"], ["catalog.brandApprovals", "Brand approvals and applying rule prices"]] },
    { hash: "packages", label: "Package sizes", fns: [["catalog.packages", "Package sizes"]] } ] },
  { key: "production", label: "Production", items: [
    { hash: "machines", label: "Machines", fns: [["production.machines", "Machines, hoops on them and stitch counts"]] },
    { hash: "maintenance", label: "Machine maintenance", fns: [["production.maintenance", "Maintenance tasks"], ["production.maintenanceLog", "Log maintenance done"]] },
    { hash: "machinefiles", label: "Machine files", fns: [["production.machinefiles", "Machine files"]] },
    { hash: "hoops", label: "Hoops", fns: [["production.hoops", "Hoops"]] },
    { hash: "threads", label: "Threads", fns: [["production.threads", "Threads, spools and needles"]] },
    { hash: "abortreasons", label: "Abort reasons", fns: [["production.abortreasons", "Abort reasons"]] },
    { hash: "digitizing", label: "Outside digitizing", fns: [["production.digitizing", "Designs sent to an outside digitizer, and their cost"]] } ] },
  { key: "inventory", label: "Inventory", items: [
    { hash: "inventory", label: "Blanks", fns: [["inventory.blanks", "Blank stock"]] },
    { hash: "blankorder", label: "Blanks to order", fns: [["inventory.blankorder", "Blanks to order and restocks"], ["inventory.supplierOrders", "Order from suppliers"]] },
    { hash: "transfers", label: "Transfers", fns: [["inventory.transfers", "Transfer stock"]] } ] },
  { key: "finance", label: "Finance", items: [
    { hash: "expenses", label: "Expenses", fns: [["finance.expenses", "Expenses"]] },
    { hash: "money", label: "Accounts and money", fns: [["finance.money", "Accounts and money"]] },
    { hash: "reconcile", label: "Reconcile", fns: [["finance.reconcile", "Reconcile statements"]] },
    { hash: "accountviewer", label: "Account viewer", fns: [["finance.accountviewer", "Account viewer"]] },
    { hash: "shoprate", label: "Shop rate", fns: [["finance.shoprate", "Shop rate"]] } ] },
  { key: "reports", label: "Reports", items: [
    { hash: "audit", label: "Audit log", fns: [["reports.audit", "Audit log"]] },
    { hash: "revenue", label: "Revenue report", fns: [["reports.revenue", "Revenue and expense reports"]] },
    { hash: "salestax", label: "Sales tax report", fns: [["reports.salestax", "Sales tax report"]] },
    { hash: "cogs", label: "Inventory and COGS", fns: [["reports.cogs", "Inventory and COGS"]] },
    { hash: "runreport", label: "Run times", fns: [["reports.runtimes", "Run times"]] },
    { hash: "fundraising", label: "Fundraising", fns: [["reports.fundraising", "Fundraising report"]] },
    { hash: "books", label: "Periods and export", fns: [["reports.books", "Closed periods and accountant's export"]] },
    { hash: "taxpacket", label: "Tax packet", fns: [["reports.taxpacket", "Printable tax packet for the accountant"]] } ] },
  { key: "settings", label: "Settings", items: [
    { hash: "settings", label: "Global settings", fns: [["settings.global", "Global settings"]] },
    { hash: "vendors", label: "Vendor integrations", fns: [["settings.vendors", "Vendor connections"]] },
    { hash: "comms", label: "Communications", fns: [["settings.comms", "Customer communications"]] },
    { hash: "orphans", label: "Orphaned images", fns: [["settings.orphans", "Orphaned images"]] },
    { hash: "users", label: "Users", fns: [["settings.users", "Users and roles"]] } ] },
];
// Always there for everyone signed in: their own account.
export const ALWAYS_ITEMS = ["security", "password"];
// Functions of no menu item: they apply on every screen, so no menu or item switch turns them off (the Roles screen
// shows them as their own rows). Money, costs and margins was the Home item's until 2026-11: hiding Home took costs
// away from Products, Blanks, Orders and the rest.
export const EVERYWHERE_FNS = [["costs.view", "Money, costs and margins (everywhere)"]];

export const PERM_FUNCTIONS = [];
export const ITEM_OF_FN = Object.create(null);
export const MENU_OF_ITEM = Object.create(null);
for (const m of PERMISSION_AREAS) for (const it of m.items) { MENU_OF_ITEM[it.hash] = m.key; for (const [k] of it.fns) { PERM_FUNCTIONS.push(k); ITEM_OF_FN[k] = it.hash; } }
for (const [k] of EVERYWHERE_FNS) PERM_FUNCTIONS.push(k);
const isEverywhere_ = (fn) => EVERYWHERE_FNS.some(([k]) => k === fn);
// A role saved before costs.view left Home has no `costsApart` mark: there, Home hidden (its item or its menu) still
// means no costs, as it did when the role was saved, so no existing role gains cost access from the move. Saving
// the role again (normalizePermissions) writes the level it then has, with the mark.
const homeHidesCosts_ = (p) => !p.costsApart && ((p.menus || {})[MENU_OF_ITEM.home] === false || (p.items || {}).home === false);

// Which function, at which level, each /api/orders action needs. Listed per function so the
// level a button needs is easy to read: read = looks, edit = adds or changes, full = deletes, voids,
// refunds, writes off. An action missing here is refused to everyone but admins (the roles test
// fails until it is placed).
const BY_FN = {
  "home.counts": { read: ["getDashboard"] },
  "costs.view": { read: ["analyzePricing", "getPricingSettings"] },
  "orders.details": {
    read: ["getOrders", "getOrdersByIds", "getOrdersAllShops", "getOpenOrders", "getOrderItemFiles", "getOrderItemDesigns", "listDesignVerifications"],
    edit: ["updateCustomerInfo", "editOrder", "updateOrderDate", "setOrderDates", "setOrderDueDate", "bulkSetDueDate", "refreshOrderFromCatalog",
      "saveOrderItemFile", "saveOrderItemDesign", "createLocalSale", "checkLocalSaleCode", "sendDesignVerification"],
    full: ["deleteOrderItemFile", "cancelLineItem", "bulkCancelLineItems", "deleteOrder", "voidOrder"] },
  "orders.stepsEarly": { read: ["getBlankShipments"], edit: ["useBlanksFromStock", "addBlankShipment", "updateBlankShipment", "checkBlankShipments"], full: ["deleteBlankShipment"] },
  "orders.stepsLate": { edit: ["setOrderCompleted", "checkDeliveries"] },
  "orders.shipping": { read: ["getOrderForShipping"], edit: ["recordTracking", "bulkRecordTracking", "setShippingInfo"] },
  "orders.payments": {
    edit: ["markPaidManual", "addPayment", "setPaymentDate", "setDiscount", "setShippingPaidAmount", "createShippingPaymentLink", "setPaymentAccount"],
    full: ["setRushFee", "recordRefund", "setRefundShipping", "deletePayment", "voidPayment", "setLineItemRefund"] },
  // Pay on delivery (migrations/0105): the order's steps go on before it's paid. Its own function, so who may let work
  // start unpaid is chosen apart from who records payments: Manager and Admin by default (Back office and Production none).
  "orders.payOnDelivery": { edit: ["setPayOnDelivery"] },
  "orders.invoices": { read: ["getInvoiceDocument", "getOrderPdf"], edit: ["sendInvoice", "resendEmail"] },
  "orders.downloads": { read: ["getOrderDownloads"], edit: ["resendDownloads", "resetDownloads"], full: ["revokeDownloads"] },
  "orders.import": { edit: ["importOrders"] },
  // Customer records (migrations/0108). A tax exemption is Full's: saveCustomer asks for Full itself when its save
  // changes one. Merging moves a customer's orders and retires the record: Full.
  "customers.records": {
    read: ["listCustomers", "getCustomer"],
    edit: ["saveCustomer", "setCustomerArchived", "setOrderCustomer", "setMarketingOptOut"],
    full: ["mergeCustomers"] },
  // Quotes (migrations/0109; "estimates" in code). Converting one makes an order, so convertEstimate also asks for
  // orders.details Edit itself (as a Local sale needs). Cancelling can't be taken back from the page: Full.
  "quotes.estimates": {
    read: ["listEstimates", "getEstimate"],
    edit: ["createEstimate", "saveEstimate", "sendEstimate", "convertEstimate"],
    full: ["cancelEstimate"] },
  // Discount codes (migrations/0115). Deleting is only for a code never used (db.js refuses one that was): Full, as
  // every other delete is. The customer's side (checkDiscountCode at checkout) needs no sign-in.
  "discounts.codes": {
    read: ["listDiscountCodes", "getDiscountCode"],
    edit: ["saveDiscountCode", "createDiscountCodes", "setDiscountCodeActive"],
    full: ["deleteDiscountCode"] },
  // Email campaigns (migrations/0117): read sees them and who they'd go to; edit writes them and sends tests; full
  // sends, schedules, cancels and deletes — emailing customers is the owner's call. Recording a customer's "no
  // marketing email" is the customer record's (Edit).
  "discounts.campaigns": {
    read: ["getCampaignStatus", "listCampaigns", "getCampaign", "previewAudience"],
    edit: ["saveCampaign", "copyCampaign", "sendCampaignTest", "runCampaignQueue"],
    full: ["scheduleCampaign", "cancelCampaign", "deleteCampaign"] },
  // The one Run order (phase 5) shows every decoration type's work: getRunQueue opens for either half (run.queue, or
  // transfer.queue through ALSO below) and leaves out the half a role has none of. Starting and finishing a line that
  // is screen printed, vinyl, DTG or sublimated is Mark made's, as embroidery's pieces are.
  "run.queue": { read: ["getProductionQueue", "getRunQueue", "listActiveRuns", "getRunStats", "getBlankReadyCounts"] },
  "run.runs": { edit: ["startRun", "completeRun", "abortRun", "markHoopingDone"] },
  "run.markMade": { edit: ["markManufacturedOnMachine", "setDecorationStarted", "makeDecoratedLine"] },
  "transfer.queue": { read: ["getTransferQueue", "getGangSheet"] },
  "transfer.mark": { edit: ["setTransferReceived", "setTransfersApplied", "makeTransferLine"] },
  "catalog.products": {
    read: ["listOrgsAdmin", "listProducts", "listProductDesigns", "listProductGraphicImages", "getTierPrices", "getCatalogIssues", "previewProductHoopings"],
    edit: ["createProduct", "updateProduct", "setProductVisible", "setProductOrder", "createProductVersion", "copyProductVersionSettings", "separateProductVersion",
      "copyProductsFromOrg", "importProducts", "setProductDesign", "setProductDesigns", "setProductGraphicImage", "setProductGraphicColorBlocked", "setTierPrices",
      "confirmProductPrices"],
    full: ["deleteProductGraphicImage"] },
  "catalog.productFiles": { read: ["listProductFiles"], edit: ["addProductFileFromDesign"], full: ["deleteProductFile"] },
  "catalog.shops": {
    read: ["getPublishState", "getPreviewLink", "getOrgDomainStatus", "getShopWizard", "listShopWizards"],
    edit: ["createOrg", "updateOrg", "setupOrgDomain", "publish", "createTestTransaction", "setOrgReady", "saveShopWizard", "buildProductFromBlank", "previewDiscardShopChanges",
      "setOrgFundraiser"],
    full: ["deleteShopWizard", "discardShopChanges"] },
  "catalog.designs": { read: ["listDesigns", "getDesign"], edit: ["saveDesign", "saveDesignVersion", "updateDesignVersionColors", "setDesignVersionStitches", "fillDesignStitchCounts"], full: ["deleteDesign"] },
  "catalog.graphics": { read: ["listGraphics"], edit: ["saveGraphic"], full: ["deleteGraphic"] },
  "catalog.categories": { read: ["listProductCategories"], edit: ["saveProductCategory"], full: ["deleteProductCategory"] },
  "catalog.locations": { read: ["listLocations"], edit: ["saveLocation"], full: ["deleteLocation"] },
  "catalog.brandrules": { read: ["getBrandRules"], edit: ["updateBrandRules"] },
  "catalog.brandApprovals": { read: ["listBrandApprovals"], edit: ["addBrandApproval", "applyRulePrices"], full: ["revokeBrandApproval"] },
  "catalog.packages": { read: ["getBoxPresets"], edit: ["setBoxPresets"] },
  "production.machines": { read: ["listMachines", "getMachine", "getMachineSettings"], edit: ["saveMachine", "setMachineHoop", "setMachineNeedle", "recordMachineDiscovery", "setMachineStitchCount"], full: ["deleteMachine"] },
  "production.maintenance": { read: ["listMaintenanceTasks", "getMaintenanceLog"], edit: ["saveMaintenanceTask"], full: ["deleteMaintenanceTask"] },
  "production.maintenanceLog": { edit: ["recordMaintenance"] },
  "production.machinefiles": {},
  "production.hoops": { read: ["listHoops"], edit: ["saveHoop"], full: ["deleteHoop"] },
  "production.threads": {
    read: ["listThreads", "listSpoolSizes", "getNeedleSettings"],
    edit: ["saveThread", "importThreadChart", "saveSpoolSize", "saveThreadInventory", "saveNeedleSize", "saveNeedleType"],
    full: ["deleteThread", "deleteSpoolSize", "deleteThreadInventory", "deleteNeedleSize", "deleteNeedleType"] },
  "production.abortreasons": { read: ["listAbortReasons"], edit: ["saveAbortReason"], full: ["deleteAbortReason"] },
  // Designs sent out to be digitized (migrations/0118): who it went to, when, what it cost. Recording its cost as an
  // expense also needs Expenses Edit (saveDigitizingJob asks for it itself). Deleting a record is Full's.
  "production.digitizing": { read: ["listDigitizingJobs"], edit: ["saveDigitizingJob"], full: ["deleteDigitizingJob"] },
  "inventory.blanks": {
    read: ["getInventory", "getBlanks", "getBlankMovements", "getBlankVendorPriceHistory", "getBlankLinks", "getReadyToShip", "getFinishedGoodsMovements",
      "previewBlankCatchUp", "previewVendorBlanks", "suggestColorGroups", "listVendorConnections", "fetchVendorProducts"],
    // Setting a product's blank links is Edit; removing one is a deletion, so Full (saveBlankLinks asks for Full when
    // its save removes any). Merging deletes blanks: Full. Counts and average cost are Full's too: the blank form
    // changes them only with Full (updateBlank), and correcting a finished-stock count is setReadyToShipQty.
    edit: ["createInventoryItem", "updateInventoryItem", "createBlank", "updateBlank", "receiveBlanks", "receiveBlankOrder", "addBlankSizes",
      "readInvoiceWithAi", "markBlankPricesChecked", "setBlankArchived", "setBlankLink", "saveBlankLinks", "applyBlankCatchUp", "makeForStock", "importBlanks",
      "applyVendorBlanks", "copyVendorImage", "removeBlankImages", "restoreInventoryMovement"],
    full: ["deleteInventoryItem", "deleteBlank", "deleteBlankLink", "mergeBlanks", "writeOffBlanks", "countBlankStock", "setReadyToShipQty", "voidInventoryMovement", "voidFinishedGoodsMovement",
      "recomputeBlankAverageCosts"] },
  "inventory.blankorder": { read: ["getBlanksToOrder", "freeShippingSuggestions", "listVendors"], edit: ["recordRestockOrder"], full: ["cancelRestockOrder", "saveVendor", "deleteVendor"] },
  "inventory.supplierOrders": { read: ["listSupplierOrders", "checkSupplierOrderShipments", "listVendorApiLog", "getVendorApiLogEntry"], edit: ["previewSupplierOrder", "placeSupplierOrder"], full: ["cancelSupplierOrder"] },
  "inventory.transfers": {
    read: ["listTransfers", "getTransferSheet", "getTransferMovements", "previewTransferCatchUp"],
    edit: ["saveTransfer", "receiveTransferSheet", "applyTransferCatchUp", "restoreTransferMovement"],
    full: ["deleteTransfer", "writeOffTransfers", "countTransferStock", "voidTransferMovement", "editTransferSheet"] },
  "finance.expenses": {
    read: ["listExpenses", "previewExpenseImport", "listRecurringExpenses", "listExpenseCategories"],
    edit: ["saveExpense", "importExpenses", "saveRecurringExpense", "stopRecurringExpense", "saveExpenseCategory", "recordFundraiserPayout"],
    full: ["deleteExpense", "deleteRecurringExpense", "deleteExpenseCategory"] },
  "finance.money": {
    read: ["listAccounts", "listMoney", "previewReceiptAccountChange", "listCashoutPayments"],
    edit: ["saveAccount", "saveMoneyDefaults", "saveMoneyEntry", "setRecordReceipt", "setReceiptAccount"],
    full: ["deleteMoneyEntry"] },
  "finance.reconcile": {
    read: ["getReconciliation"],
    edit: ["importStatement", "autoMatchStatement", "matchStatementLine", "unmatchStatementLine", "ignoreStatementLine", "createFromStatementLine"],
    full: ["reconcileMonth", "unreconcileMonth"] },
  "finance.accountviewer": { read: ["getAccountRegister"] },
  "finance.shoprate": { read: ["getShopRate"], edit: ["saveShopRate"] },
  "reports.audit": { read: ["getAuditLog"] },
  "reports.revenue": { read: ["getRevenueReport", "getExpenseReport"] },
  "reports.salestax": { read: ["getSalesTaxReport"] },
  "reports.cogs": { read: ["getInventoryReport"] },
  "reports.runtimes": { read: ["getRunReportByDesign"] },
  // Fundraising (migrations/0110): what each shop's sales raised for its group, and what was paid out to it. Recording
  // a payout is an expense, so it is Expenses' (finance.expenses Edit), not this report's.
  "reports.fundraising": { read: ["getFundraisingReport", "listFundraiserPayouts"] },
  "reports.books": { read: ["listClosedPeriods", "getAccountantExport"], edit: ["closePeriod"], full: ["reopenPeriod"] },
  // The packet is drawn from the other reports, so it needs to read them too (renderTaxPacket says which are missing).
  "reports.taxpacket": { read: ["getTaxPacketExtras"] },
  "settings.global": {
    read: ["getGlobalSettings", "getFeatures", "getBusinessProfile", "getLocaleSettings", "getSalesTaxSettings", "getShipFromAddress", "getSetupStatus",
      "getRushSettings", "getEmailSettings", "getDecorationSettings", "getDigitalSettings", "previewCustomerEmail", "samplePdf", "getAccountingSettings"],
    edit: ["saveGlobalSettingsAll", "updateGlobalSettings", "updateFeatures", "updateBusinessProfile", "updateLocaleSettings", "updateSalesTaxSettings", "updateShipFromAddress",
      "updateAccountingSettings", "updateMachineSettings", "updatePricingSettings", "updateRushSettings", "updateEmailSettings",
      "updateDecorationSettings", "sendSampleEmail", "sendTestEmail", "checkMailbox", "updateDigitalSettings", "getCloudflareSetup", "connectCloudflare", "backfillStripeFees"] },
  "settings.vendors": {
    read: ["vendorDirectorySearch", "vendorDirectoryEndpoints"],
    edit: ["saveVendorConnection", "testVendorConnection", "linkVendorConnectionBlanks"],
    full: ["deleteVendorConnection"] },
  "settings.comms": { read: ["getPendingCommunications"], edit: ["clearSystemIssues"] },
  "settings.orphans": { read: ["findOrphanImages"], full: ["deleteOrphanImages"] },
  "settings.users": {},
};

// Actions another screen also needs to read (Run Order shows designs and threads; the order screens list
// accounts and package sizes): any one of these is enough as well.
const ALSO = {
  listOrgs: "*",                  // the shop picker every screen uses
  listDesigns: [["run.queue", "read"], ["orders.details", "read"]],
  getDesign: [["run.queue", "read"], ["orders.details", "read"]],
  listGraphics: [["run.queue", "read"], ["orders.details", "read"]],
  listProductDesigns: [["run.queue", "read"]],
  listProducts: [["orders.details", "read"]],   // the Local sale window lists the shop's products (costs stay hidden: stripCosts_)
  listThreads: [["run.queue", "read"]],
  getNeedleSettings: [["run.queue", "read"]],
  listHoops: [["run.queue", "read"]],
  listMachines: [["run.queue", "read"], ["transfer.queue", "read"]],
  getMachine: [["run.queue", "read"]],
  getMachineSettings: [["production.machinefiles", "read"]],
  listAbortReasons: [["run.runs", "edit"]],
  listLocations: [["orders.details", "read"], ["run.queue", "read"]],
  getBlankReadyCounts: [["home.counts", "read"], ["inventory.blanks", "read"]],
  getBoxPresets: [["orders.shipping", "read"]],
  listBrandApprovals: [["catalog.products", "read"]],   // a product's page lists its brand approvals
  // The "paid from" / account picker of the payment window, the expense form, the Account viewer, Reconcile and the
  // Receive blanks / Receive transfers forms. Only Accounts and money gets balances with it: everyone here gets the
  // accounts' names and nothing else (orders.js listAccounts).
  listAccounts: [["orders.payments", "read"], ["finance.expenses", "read"], ["finance.accountviewer", "read"], ["finance.reconcile", "read"],
    ["inventory.blanks", "edit"], ["inventory.transfers", "edit"]],
  listExpenseCategories: [["finance.money", "read"], ["inventory.blanks", "read"], ["inventory.transfers", "read"], ["orders.payments", "edit"]],
  listClosedPeriods: [["orders.payments", "read"], ["finance.money", "read"], ["finance.expenses", "read"]],
  getRunStats: [["reports.runtimes", "read"]],
  getShipFromAddress: [["orders.shipping", "read"]],
  getBlanks: [["orders.stepsEarly", "read"], ["run.queue", "read"]],
  getBlankLinks: [["orders.details", "read"]],   // an order row says which blanks it uses
  getProductionQueue: [["transfer.queue", "read"]],
  getRunQueue: [["transfer.queue", "read"]],
  // Decoration types (Global settings → Decoration types): every screen that offers or labels a type reads the list —
  // the product and graphic forms, quotes, the Local sale, the Run order, the Transfers and Vendors pages.
  getDecorationSettings: [["catalog.products", "read"], ["catalog.graphics", "read"], ["orders.details", "read"], ["quotes.estimates", "read"],
    ["run.queue", "read"], ["transfer.queue", "read"], ["inventory.transfers", "read"], ["inventory.blankorder", "read"], ["production.machines", "read"]],
  // What a decoration costs the customer (stitch count, screen print colours, a printed transfer): the quote editor,
  // the Local sale and a product's form ask for it. Prices only; costs never come back from it.
  priceDecoration: [["quotes.estimates", "read"], ["orders.details", "edit"], ["catalog.products", "read"]],
  // An order's or a quote's digitizing jobs show where they are used; the form picks the vendor from the vendor list.
  listDigitizingJobs: [["orders.details", "read"], ["quotes.estimates", "read"]],
  listVendors: [["production.digitizing", "edit"]],
};

// action → [[fn, level], ...] (any one is enough), or "*" (anyone signed in).
export const ACTION_PERM = Object.create(null);
for (const [fn, byLevel] of Object.entries(BY_FN)) for (const lvl of ["read", "edit", "full"]) for (const a of byLevel[lvl] || []) ACTION_PERM[a] = [[fn, lvl]];
for (const [a, alt] of Object.entries(ALSO)) ACTION_PERM[a] = alt === "*" ? "*" : (ACTION_PERM[a] || []).concat(alt);
// A step change: either half of the steps is enough to reach the action; the action then checks the stage
// itself (ORDER_STEP_FN), so Production can move an order made → shipped but not order its blanks.
ACTION_PERM.setFulfillmentStage = [["orders.stepsEarly", "edit"], ["orders.stepsLate", "edit"]];
ACTION_PERM.bulkSetFulfillmentStage = [["orders.stepsEarly", "edit"], ["orders.stepsLate", "edit"]];
export const LATE_STAGES = ["manufactured", "qaPacked", "shipped", "delivered", "completed"];
export const stageFn = (stage) => LATE_STAGES.includes(stage) ? "orders.stepsLate" : "orders.stepsEarly";

// ---- Built-in roles ---------------------------------------------------------------------------
const all_ = (lvl) => Object.fromEntries(PERM_FUNCTIONS.map(k => [k, lvl]));
const only_ = (fns) => Object.assign(all_("none"), fns);
const MANAGER_FNS = Object.assign(all_("full"), {
  "settings.global": "read", "catalog.brandrules": "read", "settings.vendors": "none", "settings.orphans": "none", "settings.users": "none",
  "reports.audit": "none", "finance.shoprate": "none", "inventory.supplierOrders": "none",
});
const STAFF_FNS = only_({
  "home.counts": "read",
  "orders.details": "edit", "orders.stepsEarly": "edit", "orders.stepsLate": "edit", "orders.shipping": "edit", "orders.payments": "edit", "orders.invoices": "edit",
  "customers.records": "edit", "quotes.estimates": "edit", "discounts.codes": "read",
  "run.queue": "read", "run.runs": "edit", "run.markMade": "edit", "transfer.queue": "read", "transfer.mark": "edit",
  "production.digitizing": "edit",
  "catalog.products": "edit", "catalog.designs": "edit", "catalog.graphics": "edit", "catalog.categories": "edit", "catalog.locations": "edit",
  "production.machines": "edit", "production.maintenance": "edit", "production.maintenanceLog": "edit", "production.machinefiles": "edit",
  "production.hoops": "edit", "production.threads": "edit", "production.abortreasons": "edit",
  "inventory.blanks": "edit", "inventory.blankorder": "edit", "inventory.transfers": "edit",
  "reports.runtimes": "read", "reports.fundraising": "read", "settings.comms": "read",
});
const PRODUCTION_FNS = only_({
  "home.counts": "read",
  "orders.details": "read", "orders.stepsEarly": "read", "orders.stepsLate": "edit", "orders.shipping": "edit", "orders.invoices": "read",
  "customers.records": "read",
  "run.queue": "read", "run.runs": "edit", "run.markMade": "edit", "transfer.queue": "read", "transfer.mark": "edit",
  "production.machines": "read", "production.maintenance": "read", "production.maintenanceLog": "edit", "production.machinefiles": "read",
  "production.hoops": "read", "production.threads": "read", "production.abortreasons": "read", "production.digitizing": "read",
});
// rank: who may change whom (admin-users.js): only a higher rank lowers, raises or edits a lower one.
export const DEFAULT_ROLES = {
  admin:      { key: "admin", name: "Admin", rank: 100, builtIn: true, locked: true, permissions: { menus: {}, items: {}, fns: all_("full"), costsApart: true } },
  manager:    { key: "manager", name: "Manager", rank: 75, builtIn: true, locked: false, permissions: { menus: {}, items: {}, fns: MANAGER_FNS, costsApart: true } },
  staff:      { key: "staff", name: "Back office", rank: 50, builtIn: true, locked: false, permissions: { menus: {}, items: {}, fns: STAFF_FNS, costsApart: true } },
  production: { key: "production", name: "Production", rank: 25, builtIn: true, locked: false, permissions: { menus: {}, items: {}, fns: PRODUCTION_FNS, costsApart: true } },
};

// A permissions object as stored → a clean one: only known keys and levels; anything unknown is off.
export function normalizePermissions(p) {
  const src = p && typeof p === "object" ? p : {};
  const fns = {}, menus = {}, items = {};
  const sf = src.fns && typeof src.fns === "object" ? src.fns : {};
  for (const k of PERM_FUNCTIONS) fns[k] = PERM_LEVELS.includes(sf[k]) ? sf[k] : "none";
  for (const m of PERMISSION_AREAS) {
    if (src.menus && src.menus[m.key] === false) menus[m.key] = false;
    for (const it of m.items) if (src.items && src.items[it.hash] === false) items[it.hash] = false;
  }
  if (homeHidesCosts_(src)) for (const [k] of EVERYWHERE_FNS) fns[k] = "none";
  return { menus, items, fns, costsApart: true };
}

// The level a role really has for a function: none when its menu or item is switched off. A function of no item
// (EVERYWHERE_FNS) is its own level whatever is hidden.
export function effectiveLevel(role, fn) {
  if (!role) return "none";
  if (role.locked && role.key === "admin") return "full";
  const p = role.permissions || {};
  if (isEverywhere_(fn)) { const lvl = homeHidesCosts_(p) ? "none" : (p.fns || {})[fn]; return PERM_LEVELS.includes(lvl) ? lvl : "none"; }
  const item = ITEM_OF_FN[fn];
  if (!item) return "none";
  if ((p.menus || {})[MENU_OF_ITEM[item]] === false || (p.items || {})[item] === false) return "none";
  const lvl = (p.fns || {})[fn];
  return PERM_LEVELS.includes(lvl) ? lvl : "none";
}

// Every function's effective level, for the browser (it hides what the server would refuse).
export function effectivePermissions(role) {
  const out = {};
  for (const k of PERM_FUNCTIONS) out[k] = effectiveLevel(role, k);
  return out;
}

// Whether a role may use an action of /api/orders (ACTION_PERM). Unknown actions: admin only.
export function roleAllows(role, spec) {
  if (!role) return false;
  if (role.locked && role.key === "admin") return true;
  if (spec === "*") return true;
  if (!Array.isArray(spec) || !spec.length) return false;
  // Each entry is [function, "read" | "edit" | "full"]; anything else counts for nothing.
  return spec.some(e => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && permRank(e[1]) > 0 && permRank(effectiveLevel(role, e[0])) >= permRank(e[1]));
}
