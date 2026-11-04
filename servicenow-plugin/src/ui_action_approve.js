// UI Action: "SpareSpark: Approve part" | Table: incident | Form button
// Condition: current.correlation_display == 'SpareSpark' && current.active == true
// Approves the part the Spare Parts Agent recommended. SpareSpark rejects the call if the
// incident is not awaiting approval, and that message is shown to the user.
(function () {
  var client = new SpareSparkClient();
  try {
    var ss = client.getIncident(current);
    var part = ss.recommendation && ss.recommendation.recommended ? ss.recommendation.recommended.part_number : null;
    var res = client.approve(current, part, null);
    current.work_notes = '[SpareSpark] ' + gs.getUserDisplayName() + ' approved ' + res.selected_part_number + ' for ' + res.number + '.';
    current.setWorkflow(false);
    current.update();
    gs.addInfoMessage('Approved ' + res.selected_part_number + '. SpareSpark is reserving the part and dispatching the technician.');
  } catch (e) {
    gs.addErrorMessage(e.message);
  }
  action.setRedirectURL(current);
})();
