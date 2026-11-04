// UI Action: "Send to SpareSpark" | Table: incident | Form button
// Condition: current.correlation_display != 'SpareSpark' && !current.cmdb_ci.nil()
(function () {
  try {
    var res = new SpareSparkClient().sendIncident(current);
    current.update();
    gs.addInfoMessage('Sent to SpareSpark as ' + res.number + '. Stage updates will appear in work notes.');
  } catch (e) {
    gs.addErrorMessage(e.message);
  }
  action.setRedirectURL(current);
})();
