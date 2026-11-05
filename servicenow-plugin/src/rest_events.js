// Scripted REST API "SpareSpark" > Resource "events" (POST /events)
// Receives SpareSpark webhooks and writes them to the linked incident.
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
  var expected = String(gs.getProperty('sparespark.inbound_token', ''));
  if (expected) {
    var given = String(request.getHeader('x-sparespark-token') || '');
    if (given !== expected) {
      response.setStatus(401);
      response.setBody({ error: 'Invalid X-SpareSpark-Token' });
      return;
    }
  }
  var payload = request.body.data;
  var result = new SpareSparkClient().processEvent(payload);
  response.setStatus(result.status);
  response.setBody({ result: result.message });
})(request, response);
