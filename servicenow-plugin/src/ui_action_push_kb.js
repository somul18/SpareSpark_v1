// UI Action: "Send to SpareSpark" | Table: kb_knowledge | Form button
// Condition: current.workflow_state == 'published'
// Makes the article searchable by the SpareSpark Spare Parts Agent.
(function () {
  try {
    new SpareSparkClient().pushKnowledge(current);
    gs.addInfoMessage(current.getValue('number') + ' is now searchable by the SpareSpark Spare Parts Agent.');
  } catch (e) {
    gs.addErrorMessage(e.message);
  }
  action.setRedirectURL(current);
})();
