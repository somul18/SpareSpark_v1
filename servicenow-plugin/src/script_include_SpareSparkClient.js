/**
 * SpareSparkClient - ServiceNow side of the SpareSpark connector.
 *
 * Outbound: sends robot incidents to the standalone SpareSpark service, relays approvals,
 * rejections and repair confirmations, and pushes knowledge articles.
 * Inbound: processEvent() handles SpareSpark webhooks (called by the Scripted REST API).
 *
 * SpareSpark stays the system of record for the parts workflow. ServiceNow keeps the link in
 * incident.correlation_id (SpareSpark incident number) and correlation_display = 'SpareSpark'.
 * Written in ES5 so it runs in any global-scope script engine mode.
 */
var SpareSparkClient = Class.create();
SpareSparkClient.CORRELATION = 'SpareSpark';

SpareSparkClient.prototype = {
  initialize: function () {
    this.baseUrl = String(gs.getProperty('sparespark.base_url', '')).replace(/\/+$/, '');
    this.apiKey = String(gs.getProperty('sparespark.api_key', ''));
    this.timeoutMs = parseInt(gs.getProperty('sparespark.timeout_ms', '15000'), 10);
  },

  // ---------- HTTP ----------
  request: function (method, path, body) {
    if (!this.baseUrl) throw new Error('System property sparespark.base_url is not set');
    var rm = new sn_ws.RESTMessageV2();
    rm.setHttpMethod(method);
    rm.setEndpoint(this.baseUrl + '/api' + path);
    rm.setRequestHeader('Accept', 'application/json');
    rm.setRequestHeader('Content-Type', 'application/json');
    if (this.apiKey) rm.setRequestHeader('X-API-Key', this.apiKey);
    rm.setHttpTimeout(this.timeoutMs);
    if (body) rm.setRequestBody(JSON.stringify(body));
    var res = rm.execute();
    var status = res.getStatusCode();
    var text = res.getBody();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (status < 200 || status >= 300) {
      var msg = (data && data.error) ? data.error : ('HTTP ' + status + ' ' + (res.getErrorMessage() || ''));
      throw new Error('SpareSpark: ' + msg);
    }
    return data;
  },

  // ---------- helpers ----------
  /** Fault code from u_fault_code if the field exists, else "Fault: CODE" / "Fault code CODE" in the text. */
  extractFaultCode: function (inc) {
    if (inc.isValidField('u_fault_code') && inc.getValue('u_fault_code')) return String(inc.getValue('u_fault_code')).toUpperCase();
    var text = String(inc.getValue('short_description') || '') + '\n' + String(inc.getValue('description') || '');
    var m = text.match(/fault(?:\s*code)?\s*[:#=]?\s*([A-Z0-9][A-Z0-9_-]{2,})/i);
    return m ? m[1].toUpperCase() : null;
  },

  isLinked: function (inc) {
    return String(inc.getValue('correlation_display')) === SpareSparkClient.CORRELATION && !!inc.getValue('correlation_id');
  },

  /** True when this incident should go to SpareSpark automatically. */
  shouldSend: function (inc) {
    if (String(inc.getValue('correlation_display') || '').indexOf(SpareSparkClient.CORRELATION) === 0) return false; // linked, or a failed send awaiting manual retry
    if (!inc.getValue('cmdb_ci')) return false;
    var classes = String(gs.getProperty('sparespark.ci_classes', '')).split(',');
    var ciClass = String(inc.cmdb_ci.sys_class_name);
    var classOk = !classes.join('') || classes.indexOf(ciClass) > -1;
    return classOk && !!this.extractFaultCode(inc);
  },

  // ---------- outbound ----------
  /** Create the SpareSpark incident for a ServiceNow incident. Returns the SpareSpark incident. */
  sendIncident: function (inc, faultCode) {
    var code = faultCode || this.extractFaultCode(inc);
    if (!code) throw new Error('No fault code found. Add "Fault: <CODE>" to the short description.');
    var robotName = String(inc.cmdb_ci.name || inc.cmdb_ci.getDisplayValue() || '');
    var result = this.request('POST', '/incidents', {
      robot_name: robotName,
      fault_code: code,
      external_system: 'servicenow',
      external_ref: String(inc.getUniqueValue()),
      external_number: String(inc.getValue('number')),
      reported_by: 'ServiceNow ' + inc.getValue('number')
    });
    inc.setValue('correlation_id', result.number);
    inc.setValue('correlation_display', SpareSparkClient.CORRELATION);
    inc.work_notes = '[SpareSpark] Sent to SpareSpark as ' + result.number + ' (robot ' + robotName + ', fault ' + code + ').';
    return result;
  },

  getIncident: function (inc) {
    return this.request('GET', '/incidents/' + encodeURIComponent(inc.getValue('correlation_id')));
  },

  approve: function (inc, partNumber, comment) {
    return this.request('POST', '/incidents/' + encodeURIComponent(inc.getValue('correlation_id')) + '/approve', {
      part_number: partNumber || null,
      approver: gs.getUserDisplayName() + ' (ServiceNow)',
      comment: comment || null
    });
  },

  reject: function (inc, partNumber, comment) {
    return this.request('POST', '/incidents/' + encodeURIComponent(inc.getValue('correlation_id')) + '/reject', {
      part_number: partNumber || null,
      approver: gs.getUserDisplayName() + ' (ServiceNow)',
      comment: comment || null
    });
  },

  confirmRepair: function (inc, success, notes) {
    return this.request('POST', '/incidents/' + encodeURIComponent(inc.getValue('correlation_id')) + '/confirm-repair', {
      success: success !== false,
      notes: notes || null,
      confirmed_by: gs.getUserDisplayName() + ' (ServiceNow)'
    });
  },

  recommend: function (partNumber, robotModel) {
    return this.request('POST', '/recommendations', { part_number: partNumber, robot_model: robotModel || null });
  },

  /** Push a kb_knowledge record into SpareSpark's knowledge base. */
  pushKnowledge: function (kb) {
    var body = String(kb.getValue('text') || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    return this.request('POST', '/knowledge', {
      ref: String(kb.getValue('number')),
      source_type: 'kb_article',
      title: String(kb.getValue('short_description')),
      body: body,
      author: String(kb.author.getDisplayValue() || ''),
      external_ref: String(kb.getUniqueValue())
    });
  },

  // ---------- inbound (webhook) ----------
  /**
   * Apply a SpareSpark webhook to the linked ServiceNow incident.
   * payload: { event, sent_at, incident: { number, stage, latest_action, seq, external_ref, recommendation, ... } }
   * Returns { status, message }.
   */
  processEvent: function (payload) {
    if (!payload || !payload.incident) return { status: 400, message: 'Missing incident' };
    var ss = payload.incident;
    var inc = new GlideRecord('incident');
    var found = (ss.external_ref && inc.get(ss.external_ref)) || false;
    if (!found) {
      inc = new GlideRecord('incident');
      inc.addQuery('correlation_display', SpareSparkClient.CORRELATION);
      inc.addQuery('correlation_id', ss.number);
      inc.query();
      found = inc.next();
    }
    if (!found) return { status: 404, message: 'No incident linked to ' + ss.number };

    var note = this.formatNote(payload.event, ss);
    if (note) inc.work_notes = note;
    if (!inc.getValue('correlation_id')) {
      inc.setValue('correlation_id', ss.number);
      inc.setValue('correlation_display', SpareSparkClient.CORRELATION);
    }

    var state = String(inc.getValue('state'));
    var closed = state === '6' || state === '7' || state === '8';
    if (!closed && ss.stage !== 'Resolved' && state === '1') inc.setValue('state', 2); // New -> In Progress

    if (ss.stage === 'Resolved' && !closed && gs.getProperty('sparespark.auto_resolve', 'true') === 'true') {
      inc.setValue('state', 6);
      inc.setValue('close_code', gs.getProperty('sparespark.close_code', 'Solution provided'));
      inc.setValue('close_notes', '[SpareSpark] ' + (ss.resolution_notes || ss.latest_action) +
        ' First-time fix: ' + (ss.first_time_fix ? 'Yes' : 'No') + '. SLA: ' + (ss.sla_status || 'n/a') + '.');
    }
    inc.setWorkflow(false); // do not re-trigger the outbound business rule
    inc.update();
    return { status: 200, message: 'Updated ' + inc.getValue('number') };
  },

  formatNote: function (event, ss) {
    var lines = ['[SpareSpark ' + ss.number + '] ' + ss.stage + ': ' + (ss.latest_action || '')];
    var rec = ss.recommendation;
    if (event === 'incident.approval_requested' && rec) {
      lines.push('');
      lines.push('Spare Parts Agent recommendation: ' + rec.recommended_part + ' (' + rec.match_type + '), ' +
        rec.available + ' available in bin ' + rec.bin + '. Requested part: ' + rec.requested_part + '.');
      if (rec.sources && rec.sources.length) {
        lines.push('Evidence:');
        for (var i = 0; i < rec.sources.length; i++) {
          lines.push(' - ' + rec.sources[i].ref + ' (' + rec.sources[i].type + '): "' + rec.sources[i].excerpt + '"');
        }
      }
      if (rec.install_instructions && rec.install_instructions.length) {
        lines.push('Installation notes:');
        for (var j = 0; j < rec.install_instructions.length; j++) {
          lines.push(' - ' + rec.install_instructions[j].text + ' [' + rec.install_instructions[j].ref + ']');
        }
      }
      if (rec.other_candidates && rec.other_candidates.length) {
        var others = [];
        for (var k = 0; k < rec.other_candidates.length; k++) others.push(rec.other_candidates[k].part_number + ' (' + rec.other_candidates[k].match_type + ')');
        lines.push('Other candidates: ' + others.join(', '));
      }
      lines.push('');
      lines.push('Use "SpareSpark: Approve part" or "SpareSpark: Reject part" on this incident, or approve in the SpareSpark coordinator view.');
    }
    var po = ss.purchase_order;
    if (po && (ss.stage === 'Awaiting PO Approval' || ss.stage === 'Awaiting Delivery' || ss.stage === 'Parts Received')) {
      lines.push('Purchase order ' + po.number + ': ' + po.qty + ' x ' + po.part_number + ' from ' + (po.vendor_name || 'vendor') +
        ', status ' + po.status + (po.expected_at ? ', expected ' + String(po.expected_at).slice(0, 10) : '') + '.');
      if (ss.stage === 'Awaiting PO Approval') lines.push('Approve or reject it in the SpareSpark Procurement tab.');
    }
    if (ss.work_order && ss.stage === 'Technician Dispatched') {
      lines.push('Work order ' + ss.work_order.number + ': ' + ss.work_order.part_number + ' from bin ' + ss.work_order.bin + ' to ' + ss.work_order.location + '.');
      if (ss.work_order.install_instructions) lines.push('Instructions:\n' + ss.work_order.install_instructions);
    }
    return lines.join('\n');
  },

  type: 'SpareSparkClient'
};
