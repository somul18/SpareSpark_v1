// UI Action: "SpareSpark: Show status" | Table: incident | Form button
// Condition: current.correlation_display == 'SpareSpark'
(function () {
  var client = new SpareSparkClient();
  try {
    var ss = client.getIncident(current);
    var compact = {
      number: ss.number, stage: ss.stage, latest_action: ss.latest_action, work_order: ss.work_order,
      recommendation: ss.recommendation ? {
        requested_part: ss.recommendation.requested_part,
        match_type: ss.recommendation.match_type,
        recommended_part: ss.recommendation.recommended ? ss.recommendation.recommended.part_number : null,
        available: ss.recommendation.recommended ? ss.recommendation.recommended.available : null,
        bin: ss.recommendation.recommended ? ss.recommendation.recommended.bin : null,
        sources: ss.recommendation.recommended ? ss.recommendation.recommended.evidence.map(function (e) { return { ref: e.ref, type: e.source_label, excerpt: e.excerpt }; }) : [],
        install_instructions: ss.recommendation.install_instructions || [],
        other_candidates: []
      } : null
    };
    gs.addInfoMessage(client.formatNote(ss.stage === 'Awaiting Human Approval' ? 'incident.approval_requested' : 'status', compact).replace(/\n/g, '<br/>'));
  } catch (e) {
    gs.addErrorMessage(e.message);
  }
  action.setRedirectURL(current);
})();
