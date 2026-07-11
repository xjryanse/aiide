<?php
/** 简易转发到 Python Agent 后端 */
$cfg = require __DIR__ . '/../../config/config.php';

header('Content-Type: application/json; charset=utf-8');

$action = $_GET['action'] ?? 'sessions';
$base = rtrim($cfg['agent_base'], '/');

$method = 'GET';
$path = null;
$body = null;

$map = [
    'health'   => '/v1/health',
    'sessions' => '/v1/sessions',
];

// 读取 POST 请求体(用于 rename / stop / export 等)
$raw = file_get_contents('php://input') ?: '';

if ($action === 'messages') {
    $sid = preg_replace('/[^a-zA-Z0-9]/', '', $_GET['sid'] ?? '');
    if (!$sid) { echo json_encode(['error' => 'missing sid']); exit; }
    $path = "/v1/sessions/$sid/messages";
} elseif ($action === 'delete_session') {
    $sid = preg_replace('/[^a-zA-Z0-9]/', '', $_GET['sid'] ?? '');
    if (!$sid) { echo json_encode(['error' => 'missing sid']); exit; }
    $path = "/v1/sessions/$sid";
    $method = 'DELETE';
} elseif ($action === 'rename_session') {
    $sid = preg_replace('/[^a-zA-Z0-9]/', '', $_GET['sid'] ?? '');
    if (!$sid) { echo json_encode(['error' => 'missing sid']); exit; }
    $path = "/v1/sessions/$sid";
    $method = 'PATCH';
    $body = $raw ?: json_encode(['title' => $_GET['title'] ?? '']);
} elseif ($action === 'stop') {
    $path = '/v1/chat/stop';
    $method = 'POST';
    $body = $raw ?: json_encode(['session_id' => $_GET['sid'] ?? '']);
} else {
    $path = $map[$action] ?? null;
    if (!$path) { echo json_encode(['error' => 'unknown action']); exit; }
}

$ch = curl_init($base . $path);
$opts = [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 15,
];
if ($method !== 'GET') {
    $opts[CURLOPT_CUSTOMREQUEST] = $method;
    if ($body !== null) {
        $opts[CURLOPT_POSTFIELDS] = $body;
        $opts[CURLOPT_HTTPHEADER] = ['Content-Type: application/json'];
    }
}
curl_setopt_array($ch, $opts);
$out = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
if ($out === false) {
    http_response_code(502);
    echo json_encode(['error' => 'agent unreachable: ' . curl_error($ch)], JSON_UNESCAPED_UNICODE);
} else {
    if ($code >= 400) http_response_code($code);
    echo $out;
}
curl_close($ch);
