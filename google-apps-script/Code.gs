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

var AVAILABLE_ACTIONS = ['students', 'records', 'health'];
var RECORD_ID_PROPERTY_PREFIX = 'record_id_hash:';

/**
 * GET /exec?action=students|records|health
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
 */
function doPost(e) {
  try {
    var request = parseJsonRequest_(e);
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
