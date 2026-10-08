import fs from 'fs';

function replaceInFile(file, searchStr, replaceStr) {
    if(!fs.existsSync(file)) return;
    let content = fs.readFileSync(file, 'utf8');
    content = content.split(searchStr).join(replaceStr);
    fs.writeFileSync(file, content);
}

replaceInFile('components/Sidebar.tsx', ', WifiOff }', ' }');
replaceInFile('pages/CompliancePage.tsx', ', FileText }', ' }');
replaceInFile('pages/PortfolioPage.tsx', 'const { portfolios, ', 'const { ');
replaceInFile('pages/WarRoomPage.tsx', 'currentDebateNewsId,', '');
replaceInFile('pages/WarRoomPage.tsx', "const [error, setError] = useState<string>('');\r\n", '');
replaceInFile('pages/WarRoomPage.tsx', "const [error, setError] = useState<string>('');\n", '');
replaceInFile('pages/WarRoomPage.tsx', "setError('');\r\n", '');
replaceInFile('pages/WarRoomPage.tsx', "setError('');\n", '');
replaceInFile('server/routes/aiRoutes.ts', ', shouldUseGrounding', '');
replaceInFile('stores/portfolioStore.ts', 'import { Portfolio, Holding }', 'import { Portfolio }');

const filesWithErr = ['server/routes/aiRoutes.ts', 'server/routes/newsRoutes.ts', 'server/services/rssAggregator.ts'];
for (const file of filesWithErr) {
    if(!fs.existsSync(file)) continue;
    let content = fs.readFileSync(file, 'utf8');
    content = content.replace(/catch \(err\)/g, 'catch (_err)');
    fs.writeFileSync(file, content);
}

replaceInFile('server/services/rssAggregator.ts', '(_, i)', '(_, _i)');
console.log('Fixed');
