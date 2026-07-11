<?php
/** 代理向量索引相关 API,支持 POST JSON 转发。
 * GET/POST /api/index.php?action=build|stats|search
 */
$cfg = require __DIR__ . '/../../config/config.php';

header('Content-Type: application/json; charset=utf-8');

$action = $_GET['action'] ?? '';
$base = rtrim($cfg['agent_base'], '/');

$map = [
    'build'  => ['POST', '/v1/index/build'],
    'search' => ['POST', '/v1/index/search'],
    'stats'  => ['GET',  '/v1/index/stats'],
];
if (!isset($map[$action])) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'unknown action']);
    exit;
}
list($method, $path) = $map[$action];

// stats 支持 workspace query
if ($action === 'stats' && !empty($_GET['workspace'])) {
    $path .= '?workspace=' . urlencode($_GET['workspace']);
}

// 读取 POST body
$raw = '';
if ($method === 'POST') {
    $fp = @fopen('php://input', 'rb');
    if ($fp) {
        while (!feof($fp)) {
            $chunk = fread($fp, 8192);
            if ($chunk === false) break;
            $raw .= $chunk;
        }
        fclose($fp);
    }
    if ($raw === '') $raw = '{}';
}

$ch = curl_init($base . $path);
$opts = [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 600,  // 建索引首次可能较慢(模型下载)
    CURLOPT_CUSTOMREQUEST => $method,
];
if ($method === 'POST') {
    $opts[CURLOPT_POSTFIELDS] = $raw;
    $opts[CURLOPT_HTTPHEADER] = ['Content-Type: application/json', 'Content-Length: ' . strlen($raw)];
}
curl_setopt_array($ch, $opts);
$out = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
if ($out === false) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'agent unreachable: ' . curl_error($ch)], JSON_UNESCAPED_UNICODE);
} else {
    if ($code >= 400) http_response_code($code);
    echo $out;
}
curl_close($ch);
