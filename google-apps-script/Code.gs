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
  'confidence_after',
  // 짝 관찰: 이 학생이 관찰한 짝의 student_id와, 짝에게 준 체크(출발;회전;팔치기 각 3칸)
  'observed_for',
  'peer_checks'
];
var GROWTH_FOCUS_VALUES = ['', 'start', 'turn', 'finish'];

var AVAILABLE_ACTIONS = ['students', 'records', 'growth', 'speed_confidence', 'speed_words', 'health'];

// 전체 초기화: 선생님 화면의 번호(성장판과 같은 번호)를 SHA-256으로 비교합니다.
var RESET_PIN_SHA256 = 'a1fb4e703a9ef1fa4936801721ff285a97ac85330856674412e054892afe6972';
// 마지막 초기화 시각. 각 크롬북은 학생 명단을 불러올 때 이 값을 보고 자기 기록을 지웁니다.
var RESET_AT_PROPERTY = 'RESET_AT';
// 반별 초기화 시각 ({"1": "2026-..."}). 각 크롬북은 이 값을 보고 그 반 학생의 기록만 지웁니다.
var RESET_CLASSES_PROPERTY = 'RESET_AT_BY_CLASS';
// 선생님이 정한 짝 ({"20101": "3"}). 짝 번호가 같은 학생끼리 짝(또는 3인 1조)이 됩니다.
var PAIRS_PROPERTY = 'PAIRS';
var RECORD_ID_PROPERTY_PREFIX = 'record_id_hash:';

// 속력 탐구(같은 40m를 5m×4, 10m×2, 20m×1 왕복)는 Records 시트에 activity_type으로 구분해 저장합니다.
var SPEED_ACTIVITY_TYPES = ['speed_5x4', 'speed_10x2', 'speed_20x1'];
var ALLOWED_ACTIVITY_TYPES = ['obstacle_run'].concat(SPEED_ACTIVITY_TYPES);
// AI 코칭: 스크립트 속성 GEMINI_API_KEY가 있으면 Gemini로, 없거나 실패하면 규칙 기반 코칭으로 답합니다.
var GEMINI_API_KEY_PROPERTY = 'GEMINI_API_KEY';
var GEMINI_MODEL_PROPERTY = 'GEMINI_MODEL';
// 모델이 종료되거나 붐비면(404·503) 다음 모델로 넘어갑니다. 스크립트 속성 GEMINI_MODEL이 있으면 그 모델을 먼저 씁니다.
var GEMINI_FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];
// 속력 탐구 자신감(1~10): 학생당 한 줄, 수업 전·후 점수를 덮어씁니다.
// 속력 탐구 단어 구름: 수업 처음(before)과 끝(after)에 학생들이 낸 단어 (한 단어씩 한 줄)
var SPEED_WORDS_SHEET_NAME = 'SpeedWords';
var SPEED_WORDS_HEADERS = ['created_at', 'class', 'phase', 'word'];
var SPEED_WORD_MAX_LENGTH = 20;
var SPEED_CONFIDENCE_SHEET_NAME = 'SpeedConfidence';
var SPEED_CONFIDENCE_HEADERS = [
  'updated_at',
  'student_id',
  'class',
  'number',
  'name',
  'confidence_before',
  'confidence_after'
];
var SPEED_METHOD_LABELS = { '5x4': '5m×4왕복', '10x2': '10m×2왕복', '20x1': '20m×1왕복' };

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
        ),
        reset_at: PropertiesService.getScriptProperties().getProperty(RESET_AT_PROPERTY) || '',
        reset_classes: readClassResets_(),
        pairs: readPairs_()
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

    if (action === 'speed_words') {
      var wordsSpreadsheet = getSpreadsheet_();
      getOrCreateSpeedWordsSheet_(wordsSpreadsheet);
      return jsonResponse_({
        ok: true,
        action: action,
        data: readSheetRows_(wordsSpreadsheet, SPEED_WORDS_SHEET_NAME, SPEED_WORDS_HEADERS)
      });
    }

    if (action === 'speed_confidence') {
      var confidenceSpreadsheet = getSpreadsheet_();
      getOrCreateSpeedConfidenceSheet_(confidenceSpreadsheet);
      return jsonResponse_({
        ok: true,
        action: action,
        data: readSheetRows_(
          confidenceSpreadsheet,
          SPEED_CONFIDENCE_SHEET_NAME,
          SPEED_CONFIDENCE_HEADERS
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
        ),
        pairs: readPairs_()
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
    if (request && typeof request === 'object' && request.type === 'reset') {
      return resetAll_(request);
    }
    if (request && typeof request === 'object' && request.type === 'reset_class') {
      return resetClass_(request);
    }
    if (request && typeof request === 'object' && request.type === 'pairs') {
      return savePairs_(request);
    }
    if (request && typeof request === 'object' && request.type === 'speed_coach') {
      return speedCoach_(request);
    }
    if (request && typeof request === 'object' && request.type === 'speed_class') {
      return speedClass_(request);
    }
    if (request && typeof request === 'object' && request.type === 'speed_confidence') {
      return saveSpeedConfidence_(request);
    }
    if (request && typeof request === 'object' && request.type === 'speed_word') {
      return saveSpeedWord_(request);
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

  var activityType = typeof record.activity_type === 'string' ? record.activity_type.trim() : '';
  if (ALLOWED_ACTIVITY_TYPES.indexOf(activityType) === -1) {
    throwAppError_(
      'INVALID_ACTIVITY_TYPE',
      'activity_type은 ' + ALLOWED_ACTIVITY_TYPES.join(', ') + ' 중 하나여야 합니다.',
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
    activity_type: activityType,
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

/**
 * 전체 초기화: Records·Growth 시트의 기록을 백업 탭으로 복사한 뒤 비웁니다 (1행 제목은 남김).
 * Students 시트는 건드리지 않습니다.
 */
function resetAll_(request) {
  var pin = request && typeof request.pin === 'string' ? request.pin : '';
  if (!pin || sha256Hex_(pin) !== RESET_PIN_SHA256) {
    throwAppError_('INVALID_PIN', '선생님 번호가 맞지 않습니다.', 403);
  }

  var spreadsheet = getSpreadsheet_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throwAppError_(
      'LOCK_TIMEOUT',
      '동시 저장이 많아 잠금을 획득하지 못했습니다. 잠시 후 다시 시도하세요.',
      503
    );
  }

  try {
    var now = new Date();
    var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd HHmmss');
    var cleared = {};
    [RECORDS_SHEET_NAME, GROWTH_SHEET_NAME].forEach(function (name) {
      var sheet = spreadsheet.getSheetByName(name);
      var lastRow = sheet ? sheet.getLastRow() : 0;
      cleared[name] = Math.max(0, lastRow - 1);
      if (lastRow <= 1) {
        return;
      }
      sheet.copyTo(spreadsheet).setName('백업 ' + name + ' ' + stamp);
      sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
    });

    var resetAt = now.toISOString();
    PropertiesService.getScriptProperties().setProperty(RESET_AT_PROPERTY, resetAt);

    return jsonResponse_({
      ok: true,
      reset_at: resetAt,
      cleared: cleared
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 반별 초기화: Records·Growth 시트를 백업 탭으로 복사한 뒤, class 열이 고른 반인 줄만 지웁니다.
 * 다른 반 기록과 Students 시트는 그대로 둡니다.
 */
function resetClass_(request) {
  var pin = request && typeof request.pin === 'string' ? request.pin : '';
  if (!pin || sha256Hex_(pin) !== RESET_PIN_SHA256) {
    throwAppError_('INVALID_PIN', '선생님 번호가 맞지 않습니다.', 403);
  }
  var classNo = Number(request.class);
  if (!(classNo >= 1 && classNo <= 30 && Math.floor(classNo) === classNo)) {
    throwAppError_('INVALID_REQUEST', '지울 반 번호가 올바르지 않습니다.', 400);
  }

  var spreadsheet = getSpreadsheet_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throwAppError_(
      'LOCK_TIMEOUT',
      '동시 저장이 많아 잠금을 획득하지 못했습니다. 잠시 후 다시 시도하세요.',
      503
    );
  }

  try {
    var now = new Date();
    var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd HHmmss');
    var cleared = {};
    [RECORDS_SHEET_NAME, GROWTH_SHEET_NAME].forEach(function (name) {
      var sheet = spreadsheet.getSheetByName(name);
      var lastRow = sheet ? sheet.getLastRow() : 0;
      cleared[name] = 0;
      if (lastRow <= 1) {
        return;
      }
      var lastColumn = sheet.getLastColumn();
      var classIndex = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].indexOf('class');
      if (classIndex < 0) {
        throwAppError_('SHEET_HEADER_MISMATCH', name + ' 시트에 class 열이 없습니다.', 500);
      }
      var range = sheet.getRange(2, 1, lastRow - 1, lastColumn);
      var rows = range.getValues();
      var keep = rows.filter(function (row) {
        return Number(row[classIndex]) !== classNo;
      });
      cleared[name] = rows.length - keep.length;
      if (!cleared[name]) {
        return;
      }
      sheet.copyTo(spreadsheet).setName('백업 ' + classNo + '반 ' + name + ' ' + stamp);
      range.clearContent();
      if (keep.length) {
        sheet.getRange(2, 1, keep.length, lastColumn).setValues(keep);
      }
    });

    var resetAt = now.toISOString();
    var marks = readClassResets_();
    marks[String(classNo)] = resetAt;
    PropertiesService.getScriptProperties().setProperty(RESET_CLASSES_PROPERTY, JSON.stringify(marks));

    return jsonResponse_({
      ok: true,
      class: classNo,
      reset_at: resetAt,
      reset_classes: marks,
      cleared: cleared
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 짝 저장: 고른 반 학생들의 짝 번호를 통째로 바꿉니다. 빈 값이면 그 학생은 번호순 자동 짝으로 돌아갑니다.
 * body: { type: "pairs", pin, class, groups: { student_id: "짝 번호" } }
 */
function savePairs_(request) {
  var pin = request && typeof request.pin === 'string' ? request.pin : '';
  if (!pin || sha256Hex_(pin) !== RESET_PIN_SHA256) {
    throwAppError_('INVALID_PIN', '선생님 번호가 맞지 않습니다.', 403);
  }
  var classNo = Number(request.class);
  var groups = request.groups;
  if (!(classNo >= 1 && classNo <= 30 && Math.floor(classNo) === classNo) ||
      !groups || typeof groups !== 'object' || Array.isArray(groups)) {
    throwAppError_('INVALID_REQUEST', '짝 정보가 올바르지 않습니다.', 400);
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throwAppError_(
      'LOCK_TIMEOUT',
      '동시 저장이 많아 잠금을 획득하지 못했습니다. 잠시 후 다시 시도하세요.',
      503
    );
  }

  try {
    var classIds = {};
    readSheetRows_(getSpreadsheet_(), STUDENTS_SHEET_NAME, STUDENTS_HEADERS).forEach(function (row) {
      if (Number(row.class) === classNo) {
        classIds[String(row.student_id)] = true;
      }
    });
    var pairs = readPairs_();
    Object.keys(pairs).forEach(function (id) {
      if (classIds[id]) {
        delete pairs[id];
      }
    });
    Object.keys(groups).forEach(function (id) {
      var label = String(groups[id] == null ? '' : groups[id]).trim().slice(0, 10);
      if (classIds[String(id)] && label) {
        pairs[String(id)] = label;
      }
    });
    PropertiesService.getScriptProperties().setProperty(PAIRS_PROPERTY, JSON.stringify(pairs));
    return jsonResponse_({ ok: true, class: classNo, pairs: pairs });
  } finally {
    lock.releaseLock();
  }
}

function readPairs_() {
  try {
    var parsed = JSON.parse(PropertiesService.getScriptProperties().getProperty(PAIRS_PROPERTY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function readClassResets_() {
  try {
    var parsed = JSON.parse(PropertiesService.getScriptProperties().getProperty(RESET_CLASSES_PROPERTY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function sha256Hex_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    })
    .join('');
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
      input.confidence_after,
      input.observed_for,
      input.peer_checks
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
    confidence_after: normalizeConfidence_(growth.confidence_after, 'confidence_after'),
    observed_for: normalizeOptionalText_(growth.observed_for, 64),
    peer_checks: normalizePeerChecks_(growth.peer_checks)
  };
}

/** 짝에게 준 체크: 비어 있거나 "1,0,1;0,0,1;1,1,1" (출발;반환점 회전;팔치기) */
function normalizePeerChecks_(value) {
  var text = value === undefined || value === null ? '' : String(value).trim();
  if (!text) {
    return '';
  }
  var groups = text.split(';');
  if (groups.length !== 3) {
    throwAppError_('INVALID_GROWTH', 'peer_checks는 체크 3묶음이어야 합니다.', 400);
  }
  return groups.map(function (group) {
    return normalizeCheckList_(group, 'peer_checks');
  }).join(';');
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

// ---- 속력 탐구 AI 코칭 ----
// 학생 이름은 받지 않고, 방식별 평균속력(m/s)과 보폭(m) 숫자만 받습니다.

function normalizeSpeeds_(value) {
  var speeds = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return speeds;
  Object.keys(SPEED_METHOD_LABELS).forEach(function (key) {
    var v = Number(value[key]);
    if (isFinite(v) && v > 0 && v < 15) speeds[key] = Math.round(v * 100) / 100;
  });
  return speeds;
}

function speedCoach_(request) {
  var speeds = normalizeSpeeds_(request.speeds);
  var stride = Number(request.stride);
  stride = isFinite(stride) && stride > 0.3 && stride < 3 ? Math.round(stride * 100) / 100 : null;
  if (!Object.keys(speeds).length) {
    throwAppError_('INVALID_SPEEDS', '평균속력 값이 없습니다.', 400);
  }
  var lines = Object.keys(speeds).map(function (key) {
    return SPEED_METHOD_LABELS[key] + ': ' + speeds[key] + ' m/s';
  });
  if (stride) lines.push('20m 구간 평균 보폭: ' + stride + ' m');
  var prompt = [
    '너는 중학교 2학년 체육 수업의 달리기 코치야.',
    '학생이 같은 40m를 세 가지 왕복 방식으로 달린 평균속력이야. 방향 전환 횟수는 5m×4왕복 7번, 10m×2왕복 3번, 20m×1왕복 1번이야.',
    lines.join('\n'),
    '규칙: 한국어 두 문장 이내, 80자 안팎. 첫 문장은 숫자를 근거로 잘한 점 하나, 둘째 문장은 다음에 바꿀 점 하나.',
    '바꿀 점은 출발 자세, 방향 전환 자세, 보폭과 보수 중에서만 골라. "속도", "변위", "가속도"라는 말은 쓰지 말고 "속력", "가속", "감속"만 써.'
  ].join('\n');
  var ai = callGemini_(prompt);
  return jsonResponse_({ ok: true, text: ai || ruleSpeedCoach_(speeds, stride), source: ai ? 'ai' : 'rule' });
}

function speedClass_(request) {
  var summary = request.summary && typeof request.summary === 'object' ? request.summary : {};
  var avg = normalizeSpeeds_(summary.avg);
  var runners = Math.max(0, Math.min(200, Math.floor(Number(summary.runners) || 0)));
  if (!Object.keys(avg).length) {
    throwAppError_('INVALID_SPEEDS', '반 평균속력 값이 없습니다.', 400);
  }
  var lines = Object.keys(avg).map(function (key) {
    return SPEED_METHOD_LABELS[key] + ' 반 평균: ' + avg[key] + ' m/s';
  });
  var prompt = [
    '너는 중학교 2학년 체육 수업의 달리기 코치야. 반 학생 ' + runners + '명이 같은 40m를 세 가지 왕복 방식으로 달렸어.',
    '방향 전환 횟수는 5m×4왕복 7번, 10m×2왕복 3번, 20m×1왕복 1번이야.',
    lines.join('\n'),
    '규칙: 한국어 세 문장 이내. 숫자로 어떤 방식이 가장 빨랐는지와 그 이유(방향 전환 때 감속과 다시 가속)를 설명하고,',
    '마지막 문장은 오래달리기에서는 걷다 뛰다 하기보다 끝까지 유지할 수 있는 꾸준한 페이스가 유리하다는 것과 연결해.',
    '"속도", "변위", "가속도"라는 말은 쓰지 말고 "속력", "가속", "감속"만 써.'
  ].join('\n');
  var ai = callGemini_(prompt);
  return jsonResponse_({ ok: true, text: ai || ruleSpeedClass_(avg), source: ai ? 'ai' : 'rule' });
}

function callGemini_(prompt) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty(GEMINI_API_KEY_PROPERTY);
  if (!apiKey) return '';
  var preferred = props.getProperty(GEMINI_MODEL_PROPERTY);
  var models = (preferred ? [preferred] : []).concat(GEMINI_FALLBACK_MODELS.filter(function (model) {
    return model !== preferred;
  }));
  for (var i = 0; i < models.length; i++) {
    var text = callGeminiModel_(apiKey, models[i], prompt);
    if (text) return text;
  }
  return '';
}

function callGeminiModel_(apiKey, model, prompt) {
  try {
    var response = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
      {
        method: 'post',
        contentType: 'application/json',
        headers: { 'x-goog-api-key': apiKey },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          // 생각하는 모델은 출력 한도 안에서 생각에도 토큰을 쓰므로 넉넉하게 둡니다.
          generationConfig: { temperature: 0.4, maxOutputTokens: 1024 }
        })
      }
    );
    if (response.getResponseCode() !== 200) {
      console.warn('Gemini(' + model + ') 응답 오류: ' + response.getResponseCode() + ' ' + response.getContentText().slice(0, 300));
      return '';
    }
    var data = JSON.parse(response.getContentText());
    var candidate = data && data.candidates && data.candidates[0];
    // 답이 중간에 끊긴 경우(MAX_TOKENS 등)는 쓰지 않고 다음 모델로 넘어갑니다.
    if (!candidate || candidate.finishReason !== 'STOP') return '';
    var parts = candidate.content && candidate.content.parts;
    var text = (parts || []).map(function (part) { return part.text || ''; }).join('').trim();
    return text.slice(0, 400);
  } catch (error) {
    console.warn('Gemini(' + model + ') 호출 실패: ' + error);
    return '';
  }
}

function ruleSpeedCoach_(speeds, stride) {
  if (speeds['20x1'] && speeds['5x4']) {
    var loss = Math.round((1 - speeds['5x4'] / speeds['20x1']) * 100);
    if (loss >= 20) {
      return '5m 왕복에서 속력이 ' + loss + '% 떨어졌어요. 방향을 바꾸기 2~3걸음 전부터 보폭을 줄이고 자세를 낮춰 보세요.';
    }
    return '방향 전환이 많아도 속력을 잘 지켰어요(차이 ' + loss + '%). 이번엔 출발할 때 몸을 낮추고 짧고 빠른 걸음으로 시작해 보세요.' +
      (stride ? ' (지금 보폭 약 ' + stride + 'm)' : '');
  }
  return '세 가지 방식을 모두 달려 보면 어디에서 속력을 잃는지 비교할 수 있어요.';
}

function ruleSpeedClass_(avg) {
  if (avg['20x1'] && avg['5x4']) {
    var loss = Math.round((1 - avg['5x4'] / avg['20x1']) * 100);
    return '우리 반은 5m×4왕복이 20m×1왕복보다 평균속력이 ' + loss + '% 느렸어요. 방향을 바꿀 때마다 감속했다가 다시 가속하느라 시간이 들기 때문이에요. ' +
      '오래달리기도 걷다 뛰다 하면 매번 다시 가속해야 하니, 끝까지 유지할 수 있는 꾸준한 페이스가 유리해요.';
  }
  return '세 가지 방식 기록이 더 모이면 비교할 수 있어요.';
}

// ---- 속력 탐구 자신감 (1~10) ----

function getOrCreateSpeedConfidenceSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(SPEED_CONFIDENCE_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SPEED_CONFIDENCE_SHEET_NAME);
    sheet.getRange(1, 1, 1, SPEED_CONFIDENCE_HEADERS.length).setValues([SPEED_CONFIDENCE_HEADERS]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  return getValidatedSheet_(spreadsheet, SPEED_CONFIDENCE_SHEET_NAME, SPEED_CONFIDENCE_HEADERS);
}

function saveSpeedConfidence_(request) {
  var studentId = normalizeRequiredText_(request.student_id, 'student_id');
  if (request.phase !== 'before' && request.phase !== 'after') {
    throwAppError_('INVALID_PHASE', 'phase는 before 또는 after여야 합니다.', 400);
  }
  var value = Number(request.value);
  if (!(value >= 1 && value <= 10 && Math.floor(value) === value)) {
    throwAppError_('INVALID_CONFIDENCE', '자신감은 1~10 사이의 정수여야 합니다.', 400);
  }
  var spreadsheet = getSpreadsheet_();
  var studentsSheet = getValidatedSheet_(spreadsheet, STUDENTS_SHEET_NAME, STUDENTS_HEADERS);
  var student = findStudentById_(studentsSheet, studentId);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throwAppError_('LOCK_TIMEOUT', '동시 저장이 많아 잠금을 획득하지 못했습니다. 잠시 후 다시 시도하세요.', 503);
  }
  try {
    var sheet = getOrCreateSpeedConfidenceSheet_(spreadsheet);
    var lastRow = sheet.getLastRow();
    var ids = lastRow > 1 ? sheet.getRange(2, 2, lastRow - 1, 1).getValues() : [];
    var rowIndex = -1;
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === String(student.student_id)) { rowIndex = i + 2; break; }
    }
    var row = rowIndex > 0
      ? sheet.getRange(rowIndex, 1, 1, SPEED_CONFIDENCE_HEADERS.length).getValues()[0]
      : [null, student.student_id, student['class'], student.number, student.name, '', ''];
    row[0] = new Date();
    row[request.phase === 'before' ? 5 : 6] = value;
    if (rowIndex > 0) {
      sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    } else {
      sheet.appendRow(row);
    }
    return jsonResponse_({ ok: true, student_id: student.student_id, phase: request.phase, value: value });
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateSpeedWordsSheet_(spreadsheet) {
  var sheet = spreadsheet.getSheetByName(SPEED_WORDS_SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SPEED_WORDS_SHEET_NAME);
    sheet.getRange(1, 1, 1, SPEED_WORDS_HEADERS.length).setValues([SPEED_WORDS_HEADERS]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  return getValidatedSheet_(spreadsheet, SPEED_WORDS_SHEET_NAME, SPEED_WORDS_HEADERS);
}

// 단어 구름에 올라가면 안 되는 말. 띄어쓰기·숫자·기호를 빼고 비교합니다. (app/speed.js의 BAD_WORDS와 같은 목록)
var SPEED_BAD_WORDS = [
  '시발', '씨발', '씨바', '시바', '쓰발', '씨빨', '시빨', '씹', '병신', '븅신', '빙신', '병1신', '개새', '개색', '개세', '새끼', '색기', '섀끼', '좆', '존나', '졸라', '지랄', '미친', '미쳤', '닥쳐', '꺼져', '엿먹', '염병', '엠창', '느금', '니애미', '니엄마', '애미', '애비', '등신', '멍청', '바보', '찐따', '틀딱', '죽여', '자살', '섹스', '야동', '똥', '오줌', '방귀',
  'ㅅㅂ', 'ㅆㅂ', 'ㅂㅅ', 'ㅅㄲ', 'ㅈㄴ', 'ㅈㄹ', 'ㅁㅊ', 'ㄲㅈ', 'ㄷㅊ',
  'fuck', 'shit', 'bitch', 'sex', 'damn'
];

function speedWordProblem_(word) {
  var bare = word.toLowerCase().replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-z]/g, '');
  for (var i = 0; i < SPEED_BAD_WORDS.length; i++) {
    if (bare.indexOf(SPEED_BAD_WORDS[i]) !== -1) {
      return '그 말은 보낼 수 없어요. 내 생각을 바른 말로 써 주세요.';
    }
  }
  if (!/[가-힣a-z]/.test(bare)) {
    return 'ㅋㅋ·ㅠㅠ나 숫자·기호만으로는 보낼 수 없어요. 낱말로 써 주세요.';
  }
  if (/(.)\1\1/.test(bare)) {
    return '같은 글자를 여러 번 이어 쓸 수 없어요. 낱말로 써 주세요.';
  }
  return null;
}

function saveSpeedWord_(request) {
  var classNo = Number(request['class']);
  if (!(classNo >= 1 && classNo <= 20 && Math.floor(classNo) === classNo)) {
    throwAppError_('INVALID_CLASS', 'class는 1~20 사이의 정수여야 합니다.', 400);
  }
  if (request.phase !== 'before' && request.phase !== 'after') {
    throwAppError_('INVALID_PHASE', 'phase는 before 또는 after여야 합니다.', 400);
  }
  var word = String(request.word == null ? '' : request.word).replace(/\s+/g, ' ').trim();
  if (!word || word.length > SPEED_WORD_MAX_LENGTH) {
    throwAppError_('INVALID_WORD', '단어는 1~' + SPEED_WORD_MAX_LENGTH + '자로 써 주세요.', 400);
  }
  var problem = speedWordProblem_(word);
  if (problem) {
    throwAppError_('BAD_WORD', problem, 400);
  }
  // 시트 수식으로 해석되지 않도록 = + - @ 로 시작하면 앞에 따옴표를 붙입니다.
  if (/^[=+\-@]/.test(word)) {
    word = "'" + word;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throwAppError_('LOCK_TIMEOUT', '동시 저장이 많아 잠금을 획득하지 못했습니다. 잠시 후 다시 시도하세요.', 503);
  }
  try {
    var sheet = getOrCreateSpeedWordsSheet_(getSpreadsheet_());
    sheet.appendRow([new Date(), classNo, request.phase, word]);
    return jsonResponse_({ ok: true, 'class': classNo, phase: request.phase, word: word });
  } finally {
    lock.releaseLock();
  }
}
