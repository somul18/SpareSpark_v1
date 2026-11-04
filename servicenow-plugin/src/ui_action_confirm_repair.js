// UI Action: "SpareSpark: Confirm repair" | Table: incident | Form button
// Condition: current.correlation_display == 'SpareSpark' && current.active == true
(function () {
  try {
    var res = new SpareSparkClient().confirmRepair(current, true, null);
    gs.addInfoMessage('Repair confirmed. SpareSpark stage: ' + res.stage + '.');
  } catch (e) {
    gs.addErrorMessage(e.message);
  }
  action.setRedirectURL(current);
})();
