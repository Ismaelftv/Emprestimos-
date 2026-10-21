-- Auditoria e livro-razão de pagamentos são append-only: nenhuma alteração ou exclusão.
CREATE OR REPLACE FUNCTION caixa_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'tabela % é imutável (append-only)', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION caixa_block_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION caixa_block_mutation();
--> statement-breakpoint
CREATE TRIGGER payments_immutable BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION caixa_block_mutation();
