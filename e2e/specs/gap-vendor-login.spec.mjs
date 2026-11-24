// A saved vendor login stays on its servers (review #27): a vendor connection's login is stored encrypted and sent
// only to the service addresses it was saved with. Saving the connection again with a service address on any other
// server (a different origin) and without typing the login again is refused, so whoever may edit the connection
// can't point it at a server of their own and have the stored login sent there. A new path on a server it already
// uses is fine, and so is a new server when the login is typed again. (functions/api/orders.js saveVendorConnection.)
//
// Nothing here ever reaches a vendor: saving a connection doesn't call its servers, and the example.test hosts don't
// exist. The tests only read back what the server saved or refused. Each test makes its own connection (connections
// are install-wide) and deletes it in its finally.
import { test, expect, uniq } from "../fixtures.mjs";

const REFUSED = "A service address now points to a different server: enter the vendor login again to save it.";
const VENDOR = "https://vendor.example.test";
const OTHER = "https://collector.example.test";
// A made-up login: only ever stored encrypted on the test install.
const LOGIN = { id: "e2e-vendor-user", password: "e2e-vendor-pass-not-real" };

const endpointsOn = (origin, path = "/ps") => ({
  environment: "production",
  product: origin + path + "/product", ppc: origin + path + "/ppc", media: origin + path + "/media",
  inv: "", po: "", osn: "",
});

// The connection as the list has it (endpoints, hasCredentials; the login itself is never sent back).
const readConnection = async (api, id) => (await api("listVendorConnections")).connections.find(c => c.id === id);

// Saves a new connection on the vendor's server, with or without a login; returns its id.
const makeConnection = async (api, { credentials = LOGIN } = {}) => {
  const name = uniq("E2E Vendor");
  const r = await api("saveVendorConnection", { companyCode: "E2ETEST", name, endpoints: endpointsOn(VENDOR), ...(credentials ? { credentials } : {}) });
  expect(r.status).toBe("ok");
  const saved = await readConnection(api, r.id);
  expect(saved.hasCredentials).toBe(!!credentials);
  expect(saved.endpoints.product).toBe(VENDOR + "/ps/product");
  return { id: r.id, name };
};

const removeConnection = async (api, conn) => { if (conn) await api("deleteVendorConnection", { id: conn.id }, { allowError: true }); };

// The endpoints that matter, as a plain object, to compare before and after.
const urlsOf = (c) => ({ product: c.endpoints.product, ppc: c.endpoints.ppc, media: c.endpoints.media, inv: c.endpoints.inv, po: c.endpoints.po, osn: c.endpoints.osn });

test("a saved login isn't carried to a different server unless it is typed again", async ({ api }) => {
  let conn;
  try {
    conn = await makeConnection(api);
    const before = await readConnection(api, conn.id);

    // Each way of moving one service to another server, without the login: refused, and nothing saved.
    const moves = [
      { what: "Product Data on another host", endpoints: { ...endpointsOn(VENDOR), product: OTHER + "/product" } },
      { what: "Pricing on another host", endpoints: { ...endpointsOn(VENDOR), ppc: OTHER + "/ppc" } },
      { what: "a service that had no address, now on another host", endpoints: { ...endpointsOn(VENDOR), inv: OTHER + "/inv" } },
      { what: "the same host on another port", endpoints: { ...endpointsOn(VENDOR), product: VENDOR + ":8443/ps/product" } },
      { what: "every service on another host", endpoints: endpointsOn(OTHER) },
    ];
    for (const m of moves) {
      const r = await api("saveVendorConnection", { id: conn.id, name: conn.name, endpoints: m.endpoints }, { allowError: true, withStatus: true });
      expect(r.status, m.what).toBe(400);
      expect(r.data.status, m.what).toBe("error");
      expect(r.data.message, m.what).toBe(REFUSED);
      const now = await readConnection(api, conn.id);
      expect(urlsOf(now), m.what + ": the saved addresses are unchanged").toEqual(urlsOf(before));
      expect(now.hasCredentials, m.what).toBe(true);
      expect(now.name, m.what).toBe(conn.name);
    }
  } finally { await removeConnection(api, conn); }
});

test("a new path on a server the connection already uses keeps the saved login", async ({ api }) => {
  let conn;
  try {
    conn = await makeConnection(api);
    // A new path for Product Data, and an optional service added on the same server.
    const endpoints = { ...endpointsOn(VENDOR, "/v2"), inv: VENDOR + "/v2/inventory" };
    const r = await api("saveVendorConnection", { id: conn.id, name: conn.name, endpoints });
    expect(r.status).toBe("ok");
    const now = await readConnection(api, conn.id);
    expect(now.endpoints.product).toBe(VENDOR + "/v2/product");
    expect(now.endpoints.ppc).toBe(VENDOR + "/v2/ppc");
    expect(now.endpoints.inv).toBe(VENDOR + "/v2/inventory");
    expect(now.hasCredentials, "the saved login is kept").toBe(true);
  } finally { await removeConnection(api, conn); }
});

test("a new server is saved when the login is typed again, or when there is no saved login", async ({ api }) => {
  let withLogin, withoutLogin;
  try {
    withLogin = await makeConnection(api);
    const r = await api("saveVendorConnection", { id: withLogin.id, name: withLogin.name, endpoints: endpointsOn(OTHER), credentials: LOGIN });
    expect(r.status).toBe("ok");
    const now = await readConnection(api, withLogin.id);
    expect(urlsOf(now)).toEqual(urlsOf({ endpoints: endpointsOn(OTHER) }));
    expect(now.hasCredentials).toBe(true);

    // Once it is saved there, that server is the connection's own: a new path on it needs no login.
    const again = await api("saveVendorConnection", { id: withLogin.id, name: withLogin.name, endpoints: endpointsOn(OTHER, "/v2") });
    expect(again.status).toBe("ok");
    expect((await readConnection(api, withLogin.id)).endpoints.product).toBe(OTHER + "/v2/product");

    // A connection with no login saved has nothing to carry: it can move freely.
    withoutLogin = await makeConnection(api, { credentials: null });
    const moved = await api("saveVendorConnection", { id: withoutLogin.id, name: withoutLogin.name, endpoints: endpointsOn(OTHER) });
    expect(moved.status).toBe("ok");
    const after = await readConnection(api, withoutLogin.id);
    expect(after.endpoints.product).toBe(OTHER + "/ps/product");
    expect(after.hasCredentials).toBe(false);
  } finally { await removeConnection(api, withLogin); await removeConnection(api, withoutLogin); }
});
