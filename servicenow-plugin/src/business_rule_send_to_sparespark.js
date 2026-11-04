// Business Rule: "SpareSpark: send robot incident"
// Table: incident | When: async | Insert: true | Update: true
// Condition: new SpareSparkClient().shouldSend(current)
(function executeRule(current, previous /*null when async*/) {
  var client = new SpareSparkClient();
  try {
    client.sendIncident(current);
  } catch (e) {
    current.work_notes = '[SpareSpark] Could not send to SpareSpark: ' + e.message + ' Use the "Send to SpareSpark" button to retry.';
    current.setValue('correlation_display', 'SpareSpark (send failed)'); // stops automatic retries on every update
    gs.error('SpareSpark send failed for ' + current.getValue('number') + ': ' + e.message);
  }
  current.setWorkflow(false);
  current.update();
})(current, previous);
