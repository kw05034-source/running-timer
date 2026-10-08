/**
 * 수업기록수집시스템 Google Apps Script Web App endpoint.
 *
 * 전제:
 * - 현재 스크립트가 저장소로 사용할 Google Spreadsheet에 바인드되어 있어야 합니다.
 * - 첫 번째 행은 아래 헤더와 완전히 일치해야 합니다.
 * - record_id는 Records 헤더를 변경하지 않고 ScriptProperties에 저장하여 중복을 판별합니다.
 */

var STUDENTS_SHEET_NAME = 'Students';
var RECORDS_SHEET_NAME = 'Records';

var STUDENTS_HEADERS = [
  'student_id',
  'grade',
  'class',
  'number',
  'name',
  'group_or_team'
];

var RECORDS_HEADERS = [
  'timestamp',
  'student_id',
  'grade',
  'class',
  'number',
  'name',
  'group_or_team',
  'attempt_no',
  'record_seconds',
  'activity_type'
];

// 성장판(20m 왕복달리기 자기 개선 과정): 학생당 한 줄, 최신 상태로 덮어씁니다.
var GROWTH_SHEET_NAME = 'Growth';
var GROWTH_HEADERS = [
  'updated_at',
  'student_id',
  'class',
  'number',
  'name',
  'group_or_team',
  'attempts',
  'start_checks',
  'turn_checks',
  'finish_checks',
  'observed',
  'focus',
  'goal_seconds',
  'reflection_good',
  'reflection_next',
  'efficacy_before',
  'confidence_before',
  'efficacy_after',
  'confidence_after'
];
var GROWTH_FOCUS_VALUES = ['', 'start', 'turn', 'finish'];

var AVAILABLE_ACTIONS = ['students', 'records', 'growth', 'health'];
var RECORD_ID_PROPERTY_PREFIX = 'record_id_hash:';

/**
 * GET /exec?action=students|records|growth|health
 */
function doGet(e) {
  try {
    var action = getQueryParameter_(e, 'action');

    if (!action) {
      return jsonResponse_({
        ok: true,
        message: '사용 가능한 action을 지정하세요.',
        available_actions: AVAILABLE_ACTIONS
      });
    }

    if (action === 'students') {
      return jsonResponse_({
        ok: true,
        action: action,
        data: readSheetRows_(
          getSpreadsheet_(),
          STUDENTS_SHEET_NAME,
          STUDENTS_HEADERS
        )
      });
    }

    if (action === 'records') {
      return jsonResponse_({
        ok: true,
        action: action,
        data: readSheetRows_(
          getSpreadsheet_(),
          RECORDS_SHEET_NAME,
          RECORDS_HEADERS
        )
      });
    }

    if (action === 'growth') {
      var growthSpreadsheet = getSpreadsheet_();
      getOrCreateGrowthSheet_(growthSpreadsheet);
      return jsonResponse_({
        ok: true,
        action: action,
        data: readSheetRows_(
          growthSpreadsheet,
          GROWTH_SHEET_NAME,
          GROWTH_HEADERS
        )
      });
    }

    if (action === 'health') {
      return jsonResponse_(getHealthStatus_());
    }

    throwAppError_(
      'INVALID_ACTION',
      '지원하지 않는 action입니다. 사용 가능한 action: ' + AVAILABLE_ACTIONS.join(', '),
      400
    );
  } catch (error) {
    return errorResponseFromException_(error, 'GET_FAILED');
  }
}

/**
 * POST /exec
 * body: { type: "record", record: {...} }
 *    또는 { type: "growth", growth: {...} } (성장판 한 학생의 현재 상태)
 */
function doPost(e) {
  try {
    var request = parseJsonRequest_(e);
    if (request && typeof request === 'object' && request.type === 'growth') {
      return saveGrowth_(request);
    }
    validateRequestShape_(request);
    var inputRecord = normalizeRecordInput_(request.record);

    var spreadsheet = getSpreadsheet_();
    var studentsSheet = getValidatedSheet_(
      spreadsheet,
      STUDENTS_SHEET_NAME,
      STUDENTS_HEADERS
    );
    var recordsSheet = getValidatedSheet_(
      spreadsheet,
      RECORDS_SHEET_NAME,
      RECORDS_HEADERS
    );
    var student = findStudentById_(studentsSheet, inputRecord.student_id);
    var recordId = inputRecord.record_id || Utilities.getUuid();

    // 중복 확인과 appendRow를 하나의 임계구역에서 처리합니다.
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      throwAppError_(
        'LOCK_TIMEOUT',
        '동시 저장이 많아 잠금을 획득하지 못했습니다. 잠시 후 다시 시도하세요.',
        503
      );
    }

    try {
      var duplicate = findStoredRecordId_(recordId);
      if (duplicate) {
        return jsonResponse_({
          ok: true,
          duplicate: true,
          record_id: recordId,
          message: '이미 저장된 record_id입니다. 중복 저장하지 않았습니다.'
        });
      }

      var timestamp = new Date();
      recordsSheet.appendRow([
        timestamp,
        student.student_id,
        student.grade,
        student['class'],
        student.number,
        student.name,
        student.group_or_team,
        inputRecord.attempt_no,
        inputRecord.record_seconds,
        inputRecord.activity_type
      ]);

      storeRecordId_(recordId, timestamp);

      return jsonResponse_({
        ok: true,
        duplicate: false,
        message: '기록을 저장했습니다.',
        record_id: recordId,
        record: {
          timestamp: timestamp.toISOString(),
          student_id: student.student_id,
          grade: student.grade,
          'class': student['class'],
          number: student.number,
          name: student.name,
          group_or_team: student.group_or_team,
          attempt_no: inputRecord.attempt_no,
          record_seconds: inputRecord.record_seconds,
          activity_type: inputRecord.activity_type
        }
      });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return errorResponseFromException_(error, 'POST_FAILED');
  }
}

/** JSON 응답을 생성합니다. Apps Script Web App은 응답 본문에 상태 코드를 함께 제공합니다. */
function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse_(code, message, statusCode) {
  return jsonResponse_({
    ok: false,
    status_code: statusCode || 500,
    error: {
      code: code,
      message: message
    }
  });
}

function errorResponseFromException_(error, fallbackCode) {
  var code = error && error.code ? error.code : fallbackCode;
  var message = error && error.message
    ? error.message
    : '처리 중 알 수 없는 오류가 발생했습니다.';
  var statusCode = error && error.statusCode ? error.statusCode : 500;
  return errorResponse_(code, message, statusCode);
}

function throwAppError_(code, message, statusCode) {
  var error = new Error(message);
  error.code = code;
  error.statusCode = statusCode || 500;
  throw error;
}

function getQueryParameter_(e, name) {
  if (!e || !e.parameter || e.parameter[name] === undefined) {
    return '';
  }
  return String(e.parameter[name]).trim().toLowerCase();
}

function getSpreadsheet_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throwAppError_(
      'SPREADSHEET_NOT_FOUND',
      '활성 Spreadsheet를 찾을 수 없습니다. 이 스크립트를 저장소 Spreadsheet에 바인드하세요.',
      500
    );
  }
  return spreadsheet;
}

function getValidatedSheet_(spreadsheet, sheetName, expectedHeaders) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    throwAppError_(
      'SHEET_NOT_FOUND',
      '필수 시트가 없습니다: ' + sheetName,
      500
    );
  }

  var lastColumn = sheet.getLastColumn();
  var actualHeaders = lastColumn > 0
    ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0]
    : [];
  var headersMatch = actualHeaders.length === expectedHeaders.length &&
    expectedHeaders.every(function (header, index) {
      return actualHeaders[index] === header;
    });

  if (!headersMatch) {
    throwAppError_(
      'INVALID_HEADERS',
      '시트 "' + sheetName + '"의 1행 헤더가 올바르지 않습니다. ' +
        '기대값: ' + JSON.stringify(expectedHeaders) + ', ' +
        '현재값: ' + JSON.stringify(actualHeaders),
      500
    );
  }

  return sheet;
}

function readSheetRows_(spreadsheet, sheetName, headers) {
  var sheet = getValidatedSheet_(spreadsheet, sheetName, headers);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return [];
  }

  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.reduce(function (rows, row) {
    if (isBlankRow_(row)) {
      return rows;
    }

    var item = {};
    headers.forEach(function (header, index) {
      item[header] = serializeCellValue_(row[index]);
    });
    rows.push(item);
    return rows;
  }, []);
}

function isBlankRow_(row) {
  return row.every(function (value) {
    return value === '' || value === null;
  });
}

function serializeCellValue_(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function getHealthStatus_() {
  var spreadsheet = getSpreadsheet_();
  getValidatedSheet_(spreadsheet, STUDENTS_SHEET_NAME, STUDENTS_HEADERS);
  getValidatedSheet_(spreadsheet, RECORDS_SHEET_NAME, RECORDS_HEADERS);

  return {
    ok: true,
    status: 'ok',
    message: 'Students와 Records 시트 및 헤더가 정상입니다.',
    spreadsheet_name: spreadsheet.getName(),
    sheets: [STUDENTS_SHEET_NAME, RECORDS_SHEET_NAME]
  };
}

function parseJsonRequest_(e) {
  if (!e || !e.postData || typeof e.postData.contents !== 'string' ||
      !e.postData.contents.trim()) {
    throwAppError_(
      'INVALID_JSON_BODY',
      '요청 본문에 JSON이 필요합니다.',
      400
    );
  }

  try {
    return JSON.parse(e.postData.contents);
  } catch (error) {
    throwAppError_(
      'INVALID_JSON_BODY',
      '요청 본문이 올바른 JSON이 아닙니다.',
      400
    );
  }
}

function validateRequestShape_(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throwAppError_(
      'INVALID_REQUEST',
      '요청 본문은 { type: "record", record: {...} } 형태의 JSON 객체여야 합니다.',
      400
    );
  }

  var requestKeys = Object.keys(request);
  var hasOnlyAllowedKeys = requestKeys.every(function (key) {
    return key === 'type' || key === 'record';
  });
  if (!hasOnlyAllowedKeys || request.type !== 'record' ||
      !request.record || typeof request.record !== 'object' ||
      Array.isArray(request.record)) {
    throwAppError_(
      'INVALID_REQUEST',
      'JSON body는 type이 "record"이고 record 객체를 포함해야 합니다.',
      400
    );
  }
}

function normalizeRecordInput_(record) {
  var allowedKeys = [
    'student_id',
    'attempt_no',
    'record_seconds',
    'activity_type',
    'record_id'
  ];
  var hasOnlyAllowedKeys = Object.keys(record).every(function (key) {
    return allowedKeys.indexOf(key) !== -1;
  });
  if (!hasOnlyAllowedKeys) {
    throwAppError_(
      'INVALID_RECORD_FIELDS',
      'record에는 student_id, attempt_no, record_seconds, activity_type, record_id만 사용할 수 있습니다.',
      400
    );
  }

  var studentId = normalizeRequiredText_(record.student_id, 'student_id');
  var attemptNo = normalizeInteger_(record.attempt_no, 'attempt_no');
  var recordSeconds = normalizeNonNegativeNumber_(
    record.record_seconds,
    'record_seconds'
  );

  if (typeof record.activity_type !== 'string' ||
      record.activity_type.trim() !== 'obstacle_run') {
    throwAppError_(
      'INVALID_ACTIVITY_TYPE',
      'activity_type은 "obstacle_run"이어야 합니다.',
      400
    );
  }

  var recordId = '';
  if (record.record_id !== undefined && record.record_id !== null &&
      record.record_id !== '') {
    recordId = normalizeRequiredText_(record.record_id, 'record_id');
    if (recordId.length > 128) {
      throwAppError_(
        'INVALID_RECORD_ID',
        'record_id는 128자 이내여야 합니다.',
        400
      );
    }
  }

  return {
    student_id: studentId,
    attempt_no: attemptNo,
    record_seconds: recordSeconds,
    activity_type: 'obstacle_run',
    record_id: recordId
  };
}

function normalizeRequiredText_(value, fieldName) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throwAppError_(
      'MISSING_REQUIRED_FIELD',
      fieldName + '은(는) 필수 문자열 값입니다.',
      400
    );
  }

  var text = String(value).trim();
  if (!text) {
    throwAppError_(
      'MISSING_REQUIRED_FIELD',
      fieldName + '은(는) 비어 있을 수 없습니다.',
      400
    );
  }
  return text;
}

function normalizeInteger_(value, fieldName) {
  if (typeof value === 'boolean' || value === null || value === undefined ||
      (typeof value === 'string' && !value.trim())) {
    throwAppError_(
      'MISSING_REQUIRED_FIELD',
      fieldName + '은(는) 1 이상의 정수여야 합니다.',
      400
    );
  }

  var numberValue = Number(value);
  if (!isFinite(numberValue) || Math.floor(numberValue) !== numberValue ||
      numberValue < 1) {
    throwAppError_(
      'INVALID_NUMBER',
      fieldName + '은(는) 1 이상의 정수여야 합니다.',
      400
    );
  }
  return numberValue;
}

function normalizeNonNegativeNumber_(value, fieldName) {
  if (typeof value === 'boolean' || value === null || value === undefined ||
      (typeof value === 'string' && !value.trim())) {
    throwAppError_(
      'MISSING_REQUIRED_FIELD',
      fieldName + '은(는) 0 이상의 숫자여야 합니다.',
      400
    );
  }

  var numberValue = Number(value);
  if (!isFinite(numberValue) || numberValue < 0) {
    throwAppError_(
      'INVALID_NUMBER',
      fieldName + '은(는) 0 이상의 숫자여야 합니다.',
      400
    );
  }
  return numberValue;
}

function findStudentById_(studentsSheet, studentId) {
  var students = readSheetRows_(
    studentsSheet.getParent(),
    STUDENTS_SHEET_NAME,
    STUDENTS_HEADERS
  );
  var matches = students.filter(function (student) {
    return String(student.student_id).trim() === studentId;
  });

  if (matches.length === 0) {
    throwAppError_(
      'STUDENT_NOT_FOUND',
      'Students 시트에서 student_id를 찾을 수 없습니다: ' + studentId,
      400
    );
  }
  if (matches.length > 1) {
    throwAppError_(
      'DUPLICATE_STUDENT_ID',
      'Students 시트에 동일한 student_id가 여러 개 있습니다: ' + studentId,
      500
    );
  }
  return matches[0];
}

function findStoredRecordId_(recordId) {
  var key = getRecordIdPropertyKey_(recordId);
  var storedValue = PropertiesService.getScriptProperties().getProperty(key);
  if (storedValue === null) {
    return false;
  }

  try {
    var stored = JSON.parse(storedValue);
    if (stored.record_id === recordId) {
      return true;
    }
  } catch (error) {
    throwAppError_(
      'INVALID_RECORD_ID_STORE',
      'record_id 중복 확인 정보가 손상되었습니다. 관리자에게 확인을 요청하세요.',
      500
    );
  }

  throwAppError_(
    'RECORD_ID_COLLISION',
    'record_id 저장 키 충돌이 감지되었습니다. 다른 record_id로 다시 시도하세요.',
    500
  );
}

function storeRecordId_(recordId, timestamp) {
  var key = getRecordIdPropertyKey_(recordId);
  PropertiesService.getScriptProperties().setProperty(
    key,
    JSON.stringify({
      record_id: recordId,
      timestamp: timestamp.toISOString()
    })
  );
}

function getRecordIdPropertyKey_(recordId) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    recordId,
    Utilities.Charset.UTF_8
  );
  var hex = digest.map(function (byte) {
    var value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
  return RECORD_ID_PROPERTY_PREFIX + hex;
}

/* ---------- 성장판 (Growth 시트) ---------- */

/** Growth 시트가 없으면 헤더와 함께 만듭니다. */
function getOrCreateGrowthSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(GROWTH_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(GROWTH_SHEET_NAME);
    sheet.getRange(1, 1, 1, GROWTH_HEADERS.length).setValues([GROWTH_HEADERS]);
    sheet.setFrozenRows(1);
    // 기록 목록(예: 6.42,6.30)이 숫자로 바뀌지 않도록 텍스트 서식으로 둡니다.
    sheet.getRange(1, 1, sheet.getMaxRows(), GROWTH_HEADERS.length).setNumberFormat('@');
    return sheet;
  }
  upgradeGrowthHeaders_(sheet);
  return getValidatedSheet_(spreadsheet, GROWTH_SHEET_NAME, GROWTH_HEADERS);
}

/**
 * 예전 버전으로 만든 Growth 시트(앞쪽 헤더만 있음)에 새 헤더(자기효능감 칸)를 뒤에 덧붙입니다.
 * 기존 헤더가 새 헤더의 앞부분과 정확히 같을 때만 고치고, 그 밖의 경우는 검증 단계에서 오류를 알립니다.
 */
function upgradeGrowthHeaders_(sheet) {
  var lastColumn = sheet.getLastColumn();
  if (lastColumn <= 0 || lastColumn >= GROWTH_HEADERS.length) {
    return;
  }
  var actual = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  var isPrefix = actual.every(function (header, index) {
    return header === GROWTH_HEADERS[index];
  });
  if (!isPrefix) {
    return;
  }
  var missing = GROWTH_HEADERS.slice(lastColumn);
  sheet.getRange(1, lastColumn + 1, 1, missing.length).setValues([missing]);
  sheet.getRange(1, lastColumn + 1, sheet.getMaxRows(), missing.length).setNumberFormat('@');
}

function saveGrowth_(request) {
  var keys = Object.keys(request);
  var hasOnlyAllowedKeys = keys.every(function (key) {
    return key === 'type' || key === 'growth';
  });
  if (!hasOnlyAllowedKeys || !request.growth || typeof request.growth !== 'object' ||
      Array.isArray(request.growth)) {
    throwAppError_(
      'INVALID_REQUEST',
      'JSON body는 type이 "growth"이고 growth 객체를 포함해야 합니다.',
      400
    );
  }
  var input = normalizeGrowthInput_(request.growth);

  var spreadsheet = getSpreadsheet_();
  var studentsSheet = getValidatedSheet_(
    spreadsheet,
    STUDENTS_SHEET_NAME,
    STUDENTS_HEADERS
  );
  var student = findStudentById_(studentsSheet, input.student_id);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throwAppError_(
      'LOCK_TIMEOUT',
      '동시 저장이 많아 잠금을 획득하지 못했습니다. 잠시 후 다시 시도하세요.',
      503
    );
  }

  try {
    var sheet = getOrCreateGrowthSheet_(spreadsheet);
    var lastRow = sheet.getLastRow();
    var targetRow = 0;
    var storedUpdatedAt = '';
    if (lastRow > 1) {
      var ids = sheet.getRange(2, 2, lastRow - 1, 1).getDisplayValues();
      var times = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]).trim() === input.student_id) {
          targetRow = i + 2;
          storedUpdatedAt = String(times[i][0]);
          break;
        }
      }
    }

    // 다른 크롬북에서 더 최근에 저장한 내용은 덮어쓰지 않습니다.
    if (targetRow && storedUpdatedAt && storedUpdatedAt > input.updated_at) {
      return jsonResponse_({
        ok: true,
        stale: true,
        message: '시트에 더 최근 내용이 있어 덮어쓰지 않았습니다.'
      });
    }

    var row = [
      input.updated_at,
      student.student_id,
      student['class'],
      student.number,
      student.name,
      student.group_or_team,
      input.attempts,
      input.start_checks,
      input.turn_checks,
      input.finish_checks,
      input.observed,
      input.focus,
      input.goal_seconds,
      input.reflection_good,
      input.reflection_next,
      input.efficacy_before,
      input.confidence_before,
      input.efficacy_after,
      input.confidence_after
    ];

    if (targetRow) {
      sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }

    return jsonResponse_({
      ok: true,
      stale: false,
      message: '성장판을 저장했습니다.',
      student_id: student.student_id
    });
  } finally {
    lock.releaseLock();
  }
}

function normalizeGrowthInput_(growth) {
  var allowedKeys = GROWTH_HEADERS.filter(function (header) {
    return ['class', 'number', 'name', 'group_or_team'].indexOf(header) === -1;
  });
  var hasOnlyAllowedKeys = Object.keys(growth).every(function (key) {
    return allowedKeys.indexOf(key) !== -1;
  });
  if (!hasOnlyAllowedKeys) {
    throwAppError_(
      'INVALID_GROWTH_FIELDS',
      'growth에는 ' + allowedKeys.join(', ') + '만 사용할 수 있습니다.',
      400
    );
  }

  var updatedAt = normalizeRequiredText_(growth.updated_at, 'updated_at');
  if (isNaN(new Date(updatedAt).getTime())) {
    throwAppError_('INVALID_GROWTH', 'updated_at은 ISO 날짜 문자열이어야 합니다.', 400);
  }

  var focus = typeof growth.focus === 'string' ? growth.focus.trim() : '';
  if (GROWTH_FOCUS_VALUES.indexOf(focus) === -1) {
    throwAppError_('INVALID_GROWTH', 'focus는 start, turn, finish 중 하나여야 합니다.', 400);
  }

  var goal = '';
  if (growth.goal_seconds !== '' && growth.goal_seconds !== null &&
      growth.goal_seconds !== undefined) {
    goal = normalizeNonNegativeNumber_(growth.goal_seconds, 'goal_seconds');
  }

  return {
    student_id: normalizeRequiredText_(growth.student_id, 'student_id'),
    updated_at: updatedAt,
    attempts: normalizeNumberList_(growth.attempts, 'attempts', 50),
    start_checks: normalizeCheckList_(growth.start_checks, 'start_checks'),
    turn_checks: normalizeCheckList_(growth.turn_checks, 'turn_checks'),
    finish_checks: normalizeCheckList_(growth.finish_checks, 'finish_checks'),
    observed: Number(growth.observed) === 1 ? 1 : 0,
    focus: focus,
    goal_seconds: goal,
    reflection_good: normalizeOptionalText_(growth.reflection_good, 300),
    reflection_next: normalizeOptionalText_(growth.reflection_next, 300),
    efficacy_before: normalizeOptionalText_(growth.efficacy_before, 300),
    confidence_before: normalizeConfidence_(growth.confidence_before, 'confidence_before'),
    efficacy_after: normalizeOptionalText_(growth.efficacy_after, 300),
    confidence_after: normalizeConfidence_(growth.confidence_after, 'confidence_after')
  };
}

/** 자신감 점수: 비어 있거나 1~5 정수 */
function normalizeConfidence_(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  var number = Number(value);
  if (!isFinite(number) || Math.floor(number) !== number || number < 1 || number > 5) {
    throwAppError_('INVALID_GROWTH', fieldName + '은(는) 1~5 사이 정수여야 합니다.', 400);
  }
  return number;
}

/** "6.42,6.30" 형태의 기록 목록을 검증합니다. */
function normalizeNumberList_(value, fieldName, maxItems) {
  var text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) {
    return '';
  }
  var parts = text.split(',');
  if (parts.length > maxItems) {
    throwAppError_('INVALID_GROWTH', fieldName + '은(는) 최대 ' + maxItems + '개까지 저장할 수 있습니다.', 400);
  }
  return parts.map(function (part) {
    var number = Number(part);
    if (!isFinite(number) || number < 0 || number > 600) {
      throwAppError_('INVALID_GROWTH', fieldName + '에 올바르지 않은 숫자가 있습니다.', 400);
    }
    return number.toFixed(2);
  }).join(',');
}

/** "1,0,1" 형태의 체크 결과 3개를 검증합니다. */
function normalizeCheckList_(value, fieldName) {
  var parts = String(value === undefined || value === null ? '0,0,0' : value).split(',');
  if (parts.length !== 3) {
    throwAppError_('INVALID_GROWTH', fieldName + '은(는) 체크 3개여야 합니다.', 400);
  }
  return parts.map(function (part) {
    return String(part).trim() === '1' ? '1' : '0';
  }).join(',');
}

function normalizeOptionalText_(value, maxLength) {
  var text = value === undefined || value === null ? '' : String(value).trim();
  // 시트 수식으로 해석되지 않도록 맨 앞의 = + - @ 앞에 작은따옴표를 붙입니다.
  if (/^[=+\-@]/.test(text)) {
    text = "'" + text;
  }
  return text.slice(0, maxLength);
}
