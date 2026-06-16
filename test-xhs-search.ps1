$body = @{
    keyword = "双眼皮"
    maxNotes = 2
} | ConvertTo-Json -Compress

$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
$response = Invoke-WebRequest -Uri "http://localhost:18911/api/xhs/search/start" -Method POST -ContentType "application/json; charset=utf-8" -Body $bytes -UseBasicParsing
Write-Output $response.Content
