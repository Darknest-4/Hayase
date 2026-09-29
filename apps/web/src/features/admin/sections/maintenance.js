// Admin — Karbantartás.
//
// A PageAdmin-ba olvad be, amikor valaki megnyitja ezt a szakaszt
// (`PageAdmin.loadSection('maintenance')`, pages/admin.js). A metódusok `this`-e ezért
// a PageAdmin: a közös segédeket (dashPanel, dayLabel…) és a többi betöltött
// szakasz tagjait onnan érik el. A kód az admin.js-ből változatlanul került ide.

import { U } from '../../../shared/lib/dom.js'

export default {
  /**
   * A karbantartási képernyő.
   *
   * A tényleges felület saját modulban van
   * (`features/maintenance/admin/maintenance-dashboard.js`): ez a fájl már
   * így is ötezer sor, és egy újabb képernyő beleírása pontosan az az
   * óriásfájl lenne, amit a 36. pont tilt.
   */
  async renderMaintenanceSection (content) {
    // Csak ebben a szakaszban kell: a panel többi része nem tölti le.
    const { renderMaintenance } = await import('../../maintenance/admin/maintenance-dashboard.js')
    await renderMaintenance(content, { toast: U.toast })
  }
}
