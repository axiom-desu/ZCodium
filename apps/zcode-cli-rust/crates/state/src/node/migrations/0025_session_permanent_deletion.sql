
      create table session_purge (
        session_id text primary key,
        root_id text not null,
        operation_id text not null,
        retained_artifacts text not null,
        workspace_path text not null,
        workspace_identity text,
        state text not null check(state in ('deleting', 'deleted'))
      );
      create index session_purge_root_idx on session_purge(root_id);
      create table session_runtime_presence (
        session_id text not null,
        owner_id text not null,
        process_id integer not null,
        primary key(session_id, owner_id)
      );
      create trigger session_purge_insert_guard before insert on session
      when exists(select 1 from session_purge where session_id=new.id)
      begin select raise(abort, 'session-data.deleting'); end;
      create trigger session_purge_child_guard before insert on session
      when exists(select 1 from session_purge where session_id=new.parent_id)
      begin select raise(abort, 'session-data.deleting'); end;
      create trigger session_purge_update_guard before update on session
      when exists(select 1 from session_purge where session_id=new.id or (new.parent_id is not old.parent_id and session_id=new.parent_id))
      begin select raise(abort, 'session-data.deleting'); end;
      
        create trigger session_purge_link_insert before insert on session_task_link
        when  exists(select 1 from session_purge where session_id=new.parent_session_id or session_id=new.child_session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_link_update before update on session_task_link
        when (new.parent_session_id is not old.parent_session_id or new.child_session_id is not old.child_session_id) and new.parent_session_id is not null and exists(select 1 from session_purge where session_id=new.parent_session_id or session_id=new.child_session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      
      create trigger session_purge_runtime_guard before insert on session_runtime_presence
      when exists(select 1 from session_purge where session_id=new.session_id)
      begin select raise(abort, 'session-data.deleting'); end;
      
        create trigger session_purge_message_insert before insert on message
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_message_update before update on message
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_part_insert before insert on part
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_part_update before update on part
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_session_input_insert before insert on session_input
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_session_input_update before update on session_input
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_session_entry_insert before insert on session_entry
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_session_entry_update before update on session_entry
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_todo_insert before insert on todo
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_todo_update before update on todo
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_model_usage_insert before insert on model_usage
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_model_usage_update before update on model_usage
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_session_target_insert before insert on session_target
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_session_target_update before update on session_target
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_turn_usage_insert before insert on turn_usage
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_turn_usage_update before update on turn_usage
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_tool_usage_insert before insert on tool_usage
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_tool_usage_update before update on tool_usage
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_input_history_insert before insert on input_history
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_input_history_update before update on input_history
        when exists(select 1 from session_purge where session_id=new.session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      
      
        create trigger session_purge_owner_dwf_run_insert before insert on dwf_run
        when new.parent_session_id is not null and exists(select 1 from session_purge where session_id=new.parent_session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_owner_dwf_run_update before update on dwf_run
        when new.parent_session_id is not null and exists(select 1 from session_purge where session_id=new.parent_session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_owner_workflow_run_insert before insert on workflow_run
        when new.parent_session_id is not null and exists(select 1 from session_purge where session_id=new.parent_session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_owner_workflow_run_update before update on workflow_run
        when new.parent_session_id is not null and exists(select 1 from session_purge where session_id=new.parent_session_id)
        begin select raise(abort, 'session-data.deleting'); end;
      
      
        create trigger session_purge_reference_dwf_run_args_json_insert before insert on dwf_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.args_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_run_args_json_update before update of args_json on dwf_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.args_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_run_result_json_insert before insert on dwf_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.result_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_run_result_json_update before update of result_json on dwf_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.result_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_run_failure_json_insert before insert on dwf_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.failure_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_run_failure_json_update before update of failure_json on dwf_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.failure_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_run_args_json_insert before insert on workflow_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.args_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_run_args_json_update before update of args_json on workflow_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.args_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_run_stats_json_insert before insert on workflow_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.stats_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_run_stats_json_update before update of stats_json on workflow_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.stats_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_run_failure_json_insert before insert on workflow_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.failure_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_run_failure_json_update before update of failure_json on workflow_run
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.failure_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_node_input_json_insert before insert on dwf_node
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.input_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_node_input_json_update before update of input_json on dwf_node
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.input_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_node_result_json_insert before insert on dwf_node
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.result_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_node_result_json_update before update of result_json on dwf_node
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.result_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_node_error_json_insert before insert on dwf_node
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.error_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_node_error_json_update before update of error_json on dwf_node
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.error_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_event_payload_json_insert before insert on dwf_event
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.payload_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_event_payload_json_update before update of payload_json on dwf_event
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.payload_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_actor_persona_json_insert before insert on dwf_actor
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.persona_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_dwf_actor_persona_json_update before update of persona_json on dwf_actor
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.persona_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_activity_prompt_insert before insert on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.prompt, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_activity_prompt_update before update of prompt on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.prompt, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_activity_opts_json_insert before insert on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.opts_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_activity_opts_json_update before update of opts_json on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.opts_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_activity_result_json_insert before insert on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.result_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_activity_result_json_update before update of result_json on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.result_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_activity_error_json_insert before insert on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.error_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_activity_error_json_update before update of error_json on workflow_activity
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.error_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_event_payload_json_insert before insert on workflow_event
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.payload_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_workflow_event_payload_json_update before update of payload_json on workflow_event
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.payload_json, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_part_data_insert before insert on part
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.data, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_part_data_update before update of data on part
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.data, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_message_data_insert before insert on message
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.data, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_message_data_update before update of data on message
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.data, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_session_entry_data_insert before insert on session_entry
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.data, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_session_entry_data_update before update of data on session_entry
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.data, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_session_input_payload_insert before insert on session_input
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.payload, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_session_input_payload_update before update of payload on session_input
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.payload, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_session_revert_insert before insert on session
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.revert, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_session_revert_update before update of revert on session
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.revert, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_input_history_attachments_insert before insert on input_history
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.attachments, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      

        create trigger session_purge_reference_input_history_attachments_update before update of attachments on input_history
        when exists(select 1 from session_purge where state='deleting'
          and instr(new.attachments, 'zcode-artifact://' || session_id || '/')>0)
        begin select raise(abort, 'session-data.deleting'); end;
      
    