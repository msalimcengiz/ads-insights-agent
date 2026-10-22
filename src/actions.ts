import type pg from 'pg';

export class ActionError extends Error {}

/**
 * Applies a pending proposal. Runs in one transaction with the row locked, so a
 * double click or two reviewers can never apply the same action twice.
 */
export async function decideAction(
  pool: pg.Pool,
  accountId: string,
  actionId: string,
  decision: 'approve' | 'reject',
): Promise<{ id: string; status: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ kind: string; campaign_id: string; params: { to?: number }; status: string }>(
      `SELECT kind, campaign_id, params, status FROM proposed_actions
       WHERE id = $1 AND account_id = $2 FOR UPDATE`,
      [actionId, accountId],
    );
    const a = rows[0];
    if (!a) throw new ActionError('action not found');
    if (a.status !== 'pending') throw new ActionError(`action already ${a.status}`);

    if (decision === 'approve') {
      if (a.kind === 'pause_campaign') {
        await client.query(`UPDATE campaigns SET status = 'paused' WHERE id = $1`, [a.campaign_id]);
      } else if (a.kind === 'resume_campaign') {
        await client.query(`UPDATE campaigns SET status = 'active' WHERE id = $1`, [a.campaign_id]);
      } else {
        await client.query('UPDATE campaigns SET daily_budget = $2 WHERE id = $1', [a.campaign_id, a.params.to]);
      }
    }
    const status = decision === 'approve' ? 'approved' : 'rejected';
    await client.query('UPDATE proposed_actions SET status = $2, decided_at = now() WHERE id = $1', [actionId, status]);
    await client.query('COMMIT');
    return { id: actionId, status };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
