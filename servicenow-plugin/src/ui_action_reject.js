// UI Action: "SpareSpark: Reject part" | Table: incident | Form button
// Condition: current.correlation_display == 'SpareSpark' && current.active == true
// Rejects the current recommendation; SpareSpark proposes the next candidate or flags the
// incident as Needs Attention.
(function () {
  var client = new SpareSparkClient();
  try {
    var res = client.reject(current, null, 'Rejected from ServiceNow ' + current.getValue('number'));
    gs.addInfoMessage('Recommendation rejected. SpareSpark stage: ' + res.stage + '. ' + res.latest_action);
  } catch (e) {
    gs.addErrorMessage(e.message);
  }
  action.setRedirectURL(current);
})();
