-- Versioned list cache (2026-11): the admin's reference lists (blanks, threads, hoops, locations, machines and
-- shops) are kept on the server (isolate memory + Cache API) and in the browser, each under a version number held
-- here. Every change to a table behind a list adds 1 to that list's version, through the triggers below, in the
-- same statement as the change, so no code path (stock used on the Manufactured step, run counters, a cascade, a
-- future action) can leave a cached copy looking current. A read that sends the version it holds gets back only
-- "unchanged"; any other read gets the list and its new version (db.js readCachedList_, admin.js listCacheTake_).
--   name     the list: blanks (blanks, blank_sizes, blank_colors, needle_types), threads (threads,
--            thread_inventory, spool_sizes), hoops, locations, machines (machines, machine_hoops, machine_needles,
--            machine_maintenance_tasks) and orgs; plus '_ns', a random number per database so two installs that
--            share a Cloudflare zone never share Cache API keys.
--   version  starts at 1 and only goes up.
-- ADDITIVE: a new table and triggers.
CREATE TABLE IF NOT EXISTS list_cache_versions (
  name     TEXT    PRIMARY KEY,
  version  INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO list_cache_versions (name, version) VALUES
  ('blanks', 1), ('threads', 1), ('hoops', 1), ('locations', 1), ('machines', 1), ('orgs', 1), ('_ns', abs(random()) % 1000000000000);

CREATE TRIGGER IF NOT EXISTS lcv_blanks_ins AFTER INSERT ON blanks
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blanks_upd AFTER UPDATE ON blanks
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blanks_del AFTER DELETE ON blanks
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blank_sizes_ins AFTER INSERT ON blank_sizes
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blank_sizes_upd AFTER UPDATE ON blank_sizes
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blank_sizes_del AFTER DELETE ON blank_sizes
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blank_colors_ins AFTER INSERT ON blank_colors
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blank_colors_upd AFTER UPDATE ON blank_colors
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_blank_colors_del AFTER DELETE ON blank_colors
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_needle_types_ins AFTER INSERT ON needle_types
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_needle_types_upd AFTER UPDATE ON needle_types
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_needle_types_del AFTER DELETE ON needle_types
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'blanks'; END;
CREATE TRIGGER IF NOT EXISTS lcv_threads_ins AFTER INSERT ON threads
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_threads_upd AFTER UPDATE ON threads
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_threads_del AFTER DELETE ON threads
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_thread_inventory_ins AFTER INSERT ON thread_inventory
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_thread_inventory_upd AFTER UPDATE ON thread_inventory
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_thread_inventory_del AFTER DELETE ON thread_inventory
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_spool_sizes_ins AFTER INSERT ON spool_sizes
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_spool_sizes_upd AFTER UPDATE ON spool_sizes
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_spool_sizes_del AFTER DELETE ON spool_sizes
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'threads'; END;
CREATE TRIGGER IF NOT EXISTS lcv_hoops_ins AFTER INSERT ON hoops
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'hoops'; END;
CREATE TRIGGER IF NOT EXISTS lcv_hoops_upd AFTER UPDATE ON hoops
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'hoops'; END;
CREATE TRIGGER IF NOT EXISTS lcv_hoops_del AFTER DELETE ON hoops
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'hoops'; END;
CREATE TRIGGER IF NOT EXISTS lcv_locations_ins AFTER INSERT ON locations
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'locations'; END;
CREATE TRIGGER IF NOT EXISTS lcv_locations_upd AFTER UPDATE ON locations
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'locations'; END;
CREATE TRIGGER IF NOT EXISTS lcv_locations_del AFTER DELETE ON locations
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'locations'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machines_ins AFTER INSERT ON machines
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machines_upd AFTER UPDATE ON machines
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machines_del AFTER DELETE ON machines
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_hoops_ins AFTER INSERT ON machine_hoops
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_hoops_upd AFTER UPDATE ON machine_hoops
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_hoops_del AFTER DELETE ON machine_hoops
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_needles_ins AFTER INSERT ON machine_needles
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_needles_upd AFTER UPDATE ON machine_needles
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_needles_del AFTER DELETE ON machine_needles
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_maintenance_tasks_ins AFTER INSERT ON machine_maintenance_tasks
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_maintenance_tasks_upd AFTER UPDATE ON machine_maintenance_tasks
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_machine_maintenance_tasks_del AFTER DELETE ON machine_maintenance_tasks
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'machines'; END;
CREATE TRIGGER IF NOT EXISTS lcv_orgs_ins AFTER INSERT ON orgs
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'orgs'; END;
CREATE TRIGGER IF NOT EXISTS lcv_orgs_upd AFTER UPDATE ON orgs
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'orgs'; END;
CREATE TRIGGER IF NOT EXISTS lcv_orgs_del AFTER DELETE ON orgs
BEGIN UPDATE list_cache_versions SET version = version + 1 WHERE name = 'orgs'; END;
