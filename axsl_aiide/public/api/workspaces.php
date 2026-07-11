<?php
/** 多根工作区接口:转发到 Python Agent /v1/workspaces */
$cfg = require __DIR__ . '/../../config/config.php';
header('Content-Type: application/json; charset=utf-8');

$base = rtrim($cfg['agent_base'], '/');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$raw = file_get_contents('php://input') ?: '';

$ch = curl_init($base . '/v1/workspaces');
$opts = [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 15,
];
if ($method === 'PUT' || $method === 'POST') {
    $opts[CURLOPT_CUSTOMREQUEST] = 'PUT';
    $opts[CURLOPT_POSTFIELDS] = $raw !== '' ? $raw : '{}';
    $opts[CURLOPT_HTTPHEADER] = ['Content-Type: application/json'];
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
