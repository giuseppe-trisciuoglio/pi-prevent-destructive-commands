import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand } from "../src/checker";

/**
 * Effect-based table: each destructive remote effect lists every known
 * equivalent spelling. A new bypass is added as a new row.
 */
const DESTRUCTIVE_EFFECTS: Record<string, string[]> = {
	"delete a remote branch": [
		"git push --delete origin feature",
		"git push origin :feature",
		"git push origin +:refs/heads/feature",
		"gh api -X DELETE repos/o/r/git/refs/heads/feature",
		"gh api -X delete repos/o/r/git/refs/heads/feature",
		"gh api -XDELETE repos/o/r/git/refs/heads/feature",
		"gh api -Xdelete repos/o/r/git/refs/heads/feature",
		"gh api -X=DELETE repos/o/r/git/refs/heads/feature",
		"gh api -iX DELETE repos/o/r/git/refs/heads/feature",
		"gh api -iXDELETE repos/o/r/git/refs/heads/feature",
		"gh api --method DELETE repos/o/r/git/refs/heads/feature",
		"gh api --method=delete repos/o/r/git/refs/heads/feature",
		"gh api repos/o/r/git/refs/heads/feature -X DELETE",
		'gh api -X "$M" repos/o/r/git/refs/heads/feature',
		"M=DELETE; gh api -X $M repos/o/r/git/refs/heads/feature",
		"gh api --method=${M} repos/o/r/git/refs/heads/feature",
		'gh api -X "$(echo DELETE)" repos/o/r/git/refs/heads/feature',
		"for b in a c; do gh api -X DELETE repos/o/r/git/refs/heads/$b; done",
		'curl -X DELETE -H "Authorization: token $(gh auth token)" https://api.github.com/repos/o/r/git/refs/heads/feature',
		'curl -XDELETE -H "Authorization: Bearer $(gh auth token)" https://api.github.com/repos/o/r/git/refs/heads/feature',
		"curl -sSXDELETE https://api.github.com/repos/o/r/git/refs/heads/feature",
		"curl --request DELETE https://api.github.com/repos/o/r/git/refs/heads/feature",
		"curl --request=delete api.github.com/repos/o/r/git/refs/heads/feature",
		'curl -X "$M" https://api.github.com/repos/o/r/git/refs/heads/feature',
		'curl -X DELETE -H "Authorization: token $(gh auth token)" "$URL"',
		'curl -X DELETE -H "Authorization: token $GH_TOKEN" "$URL"',
		"wget --method=DELETE https://api.github.com/repos/o/r/git/refs/heads/feature",
		"wget --method DELETE -O- https://api.github.com/repos/o/r/git/refs/heads/feature",
		"http DELETE https://api.github.com/repos/o/r/git/refs/heads/feature",
		'https delete api.github.com/repos/o/r/git/refs/heads/feature "Authorization:token $(gh auth token)"',
		"xh DELETE api.github.com/repos/o/r/git/refs/heads/feature",
		'xh "$M" api.github.com/repos/o/r/git/refs/heads/feature',
		"gh api graphql -f query='mutation { deleteRef(input:{refId:\"x\"}) { clientMutationId } }'",
		'gh api graphql -f "query=mutation { deleteRef(input:{refId:\\"x\\"}) { clientMutationId } }"',
		"gh api graphql --raw-field=query='mutation{deleteRef(input:{refId:\"x\"}){clientMutationId}}'",
		"gh api graphql -f query='mutation($id:ID!){ updateRefs(input:{repositoryId:$id, refUpdates:[]}) { clientMutationId } }'",
		`curl -H "Authorization: bearer $(gh auth token)" -d '{"query":"mutation { deleteRef(input:{refId:\\"x\\"}) { clientMutationId } }"}' https://api.github.com/graphql`,
	],
	"delete a repository": [
		"gh repo delete o/r --yes",
		"gh api -X DELETE repos/o/r",
		"gh api graphql -f query='mutation { deleteRepository(input:{repositoryId:\"x\"}) { clientMutationId } }'",
		"curl -X DELETE https://api.github.com/repos/o/r",
	],
	"delete an issue": [
		"gh api graphql -F query='mutation { deleteIssue(input:{issueId:\"x\"}) { clientMutationId } }'",
		"gh api -X DELETE repos/o/r/issues/comments/1",
	],
	"archive or transfer": [
		"gh api graphql -f query='mutation { archiveRepository(input:{repositoryId:\"x\"}) { clientMutationId } }'",
		"gh api graphql -f query='mutation { transferIssue(input:{issueId:\"x\", repositoryId:\"y\"}) { issue { id } } }'",
	],
	"opaque GraphQL payload": [
		'gh api graphql -f query="$Q"',
		"gh api graphql -f query=\"$(cat q.graphql)\"",
		"gh api graphql -F query=@-",
		"gh api graphql --input -",
		"gh api graphql -F query=@does-not-exist.graphql",
		"gh api graphql --input does-not-exist.json",
		"curl -d @does-not-exist.json https://api.github.com/graphql",
	],
};

const SAFE_COMMANDS: string[] = [
	"gh api repos/owner/name",
	"gh api -X GET repos/owner/name",
	"gh api -XGET repos/owner/name",
	"gh api --method POST repos/owner/name/issues -f title=hi",
	"gh api --method PATCH repos/owner/name -f description=x",
	"gh pr view 14",
	"gh repo view owner/name",
	"gh release list",
	"gh api graphql -f query='query { viewer { login } }'",
	"gh api graphql -f query='query($o:String!){ repository(owner:$o, name:\"r\") { id } }' -f o=me",
	"gh api graphql -f query='mutation { addComment(input:{subjectId:\"x\", body:\"removed it\"}) { clientMutationId } }'",
	"gh api graphql -f query='{ viewer { login } }' --jq .data",
	"gh auth token",
	'curl -H "Authorization: token $(gh auth token)" https://api.github.com/repos/o/r',
	"curl -X GET https://api.github.com/repos/o/r",
	"curl -X DELETE https://example.com/items/1",
	'curl -X DELETE "$URL"',
	'curl -H "Authorization: token $(gh auth token)" -X DELETE https://example.com/x',
	"curl -s https://raw.githubusercontent.com/o/r/main/README.md",
	"wget https://api.github.com/repos/o/r",
	"http https://api.github.com/repos/o/r",
	"http GET api.github.com/repos/o/r",
	"xh api.github.com/repos/o/r",
	`curl -d '{"query":"query { viewer { login } }"}' https://api.github.com/graphql`,
	"gh api repos/o/r; echo -X $M",
	// `gh pr merge -d` deletes a branch that is already reachable from the base.
	"gh pr merge 31 --merge --delete-branch",
	"gh pr merge 31 -d --squash",
	"gh pr close 31",
	"gh pr close 31 --comment 'closing'",
	"gh pr close 31 -c -d",
	"gh pr close 31 -Rd",
	"gh pr close 31 --delete-branch=false",
];

async function main(): Promise<void> {
	const cwd = process.cwd();

	for (const [effect, commands] of Object.entries(DESTRUCTIVE_EFFECTS)) {
		for (const command of commands) {
			const r = checkCommand(command, cwd);
			assert.equal(r.dangerous, true, `expected block (${effect}): ${command}`);
		}
	}

	// Blocked: destructive gh subcommands.
	for (const command of [
		"gh repo rename new-name --yes",
		"gh release delete v1.0.0 --yes",
		"gh gist delete abc123",
		"gh secret delete MY_SECRET",
		"gh variable delete MY_VAR",
		"gh label delete bug",
		"gh run delete 12345",
		"echo hi && gh api -X DELETE repos/owner/name",
		// Side-effect deletion: closing an unmerged PR and deleting its branch.
		"gh pr close 31 --delete-branch",
		"gh pr close 31 -d",
		"gh pr close -d 31",
		"gh pr close 31 --delete-branch=true",
		"gh pr close 31 -dc 'superseded'",
		"gh pr close 31 -R owner/repo -d",
		"gh -R owner/repo pr close 31 --delete-branch",
		"gh pr close 31 --comment 'bye' -d",
	]) {
		const r = checkCommand(command, cwd);
		assert.equal(r.dangerous, true, `expected block: ${command}`);
	}

	for (const command of SAFE_COMMANDS) {
		const r = checkCommand(command, cwd);
		assert.equal(r.dangerous, false, `expected allow: ${command} — ${r.reason}`);
	}

	// GraphQL payload files are read and inspected.
	const dir = mkdtempSync(join(tmpdir(), "gh-guard-"));
	try {
		writeFileSync(join(dir, "del.graphql"), 'mutation { deleteRef(input:{refId:"x"}) { clientMutationId } }');
		writeFileSync(join(dir, "read.graphql"), "query { viewer { login } }");
		writeFileSync(join(dir, "del.json"), '{"query":"mutation { deleteIssue(input:{issueId:\\"x\\"}) { clientMutationId } }"}');
		writeFileSync(join(dir, "read.json"), '{"query":"query { viewer { login } }"}');
		for (const command of [
			"gh api graphql -F query=@del.graphql",
			"gh api graphql --field=query=@del.graphql",
			"gh api graphql --input del.json",
			"gh api graphql --input=del.json",
			"curl -d @del.json https://api.github.com/graphql",
			"curl --data-binary=@del.json https://api.github.com/graphql",
			"http POST api.github.com/graphql @del.json",
		]) {
			const r = checkCommand(command, dir);
			assert.equal(r.dangerous, true, `expected block (payload file): ${command}`);
		}
		for (const command of [
			"gh api graphql -F query=@read.graphql",
			"gh api graphql --input read.json",
			"curl -d @read.json https://api.github.com/graphql",
		]) {
			const r = checkCommand(command, dir);
			assert.equal(r.dangerous, false, `expected allow (payload file): ${command} — ${r.reason}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	console.log("gh-guard-test: OK");
}

main();
